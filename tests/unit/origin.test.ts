import { describe, expect, it } from 'vitest';

import {
  InvalidOriginError,
  assertOriginIsPubliclyRoutable,
  normaliseOrigin,
  reservedRangeFor,
} from '@/lib/sites/origin';

describe('normaliseOrigin', () => {
  it('defaults to https and strips everything below the origin', () => {
    expect(normaliseOrigin('example.com')).toBe('https://example.com');
    expect(normaliseOrigin('https://example.com/en/pricing?ref=x#top')).toBe(
      'https://example.com',
    );
  });

  it('keeps an explicit scheme and a non-default port', () => {
    expect(normaliseOrigin('http://example.com:8080/app')).toBe('http://example.com:8080');
  });

  it('drops the default port so one site is not added twice', () => {
    expect(normaliseOrigin('https://example.com:443')).toBe('https://example.com');
  });

  it('lowercases the host', () => {
    expect(normaliseOrigin('HTTPS://Example.COM/Path')).toBe('https://example.com');
  });

  it.each(['', '   '])('rejects empty input %s', (input) => {
    expect(() => normaliseOrigin(input)).toThrow(InvalidOriginError);
  });

  it.each(['ftp://example.com', 'file:///etc/passwd', 'javascript:alert(1)'])(
    'rejects the scheme in %s',
    (input) => {
      expect(() => normaliseOrigin(input)).toThrow(InvalidOriginError);
    },
  );

  // Credentials would be persisted and shown back in reports.
  it('rejects embedded credentials', () => {
    expect(() => normaliseOrigin('https://user:pass@example.com')).toThrow(/username and password/);
  });

  it('rejects a bare hostname with no dot', () => {
    expect(() => normaliseOrigin('localhost')).toThrow(/does not look like a public/);
    expect(() => normaliseOrigin('intranet')).toThrow(InvalidOriginError);
  });
});

describe('reservedRangeFor', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['10.0.0.5', 'private use'],
    ['192.168.1.1', 'private use'],
    ['172.16.4.2', 'private use'],
    // The cloud metadata endpoint. The single address most worth blocking.
    ['169.254.169.254', 'link-local'],
    ['100.64.0.1', 'carrier-grade NAT'],
  ])('flags %s as %s', (address, label) => {
    expect(reservedRangeFor(address)).toBe(label);
  });

  it.each(['8.8.8.8', '93.184.215.14', '172.32.0.1'])('allows the public address %s', (address) => {
    expect(reservedRangeFor(address)).toBeUndefined();
  });

  it.each([
    ['::1', 'loopback'],
    ['fd00::1', 'unique local'],
    ['fe80::1', 'link-local'],
  ])('flags the IPv6 address %s as %s', (address, label) => {
    expect(reservedRangeFor(address)).toBe(label);
  });

  // A v4-only check would let ::ffff:169.254.169.254 straight through.
  it('resolves IPv4-mapped IPv6 to the underlying range', () => {
    expect(reservedRangeFor('::ffff:169.254.169.254')).toBe('link-local');
    expect(reservedRangeFor('::ffff:8.8.8.8')).toBeUndefined();
  });

  it('treats unparseable input as reserved rather than allowed', () => {
    expect(reservedRangeFor('nonsense')).toBe('unparseable address');
  });
});

describe('assertOriginIsPubliclyRoutable', () => {
  const resolvesTo =
    (...addresses: string[]) =>
    () =>
      Promise.resolve(addresses.map((address) => ({ address })));

  it('accepts a host that resolves to a public address', async () => {
    const result = await assertOriginIsPubliclyRoutable(
      'https://example.com',
      resolvesTo('93.184.215.14'),
    );
    expect(result.addresses).toEqual(['93.184.215.14']);
  });

  it('rejects a host that resolves to a private address', async () => {
    await expect(
      assertOriginIsPubliclyRoutable('https://internal.example.com', resolvesTo('10.1.2.3')),
    ).rejects.toThrow(/reserved address range/);
  });

  /**
   * The case a first-address-only check would miss: one public record and one
   * private one. The private address is still reachable, so the origin is
   * still an SSRF vector.
   */
  it('rejects when any resolved address is private, not just the first', async () => {
    await expect(
      assertOriginIsPubliclyRoutable(
        'https://mixed.example.com',
        resolvesTo('93.184.215.14', '127.0.0.1'),
      ),
    ).rejects.toThrow(/127\.0\.0\.1/);
  });

  it('rejects a literal private IP without resolving anything', async () => {
    await expect(assertOriginIsPubliclyRoutable('http://192.168.0.1')).rejects.toThrow(
      /reserved address range/,
    );
  });

  it('reports a resolution failure as an actionable error', async () => {
    await expect(
      assertOriginIsPubliclyRoutable('https://nope.invalid', () =>
        Promise.reject(new Error('ENOTFOUND')),
      ),
    ).rejects.toThrow(/could not be resolved/);
  });

  it('rejects a host that resolves to nothing', async () => {
    await expect(
      assertOriginIsPubliclyRoutable('https://empty.example.com', resolvesTo()),
    ).rejects.toThrow(/did not resolve/);
  });
});
