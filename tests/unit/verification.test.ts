import { describe, expect, it, vi } from 'vitest';
import { VerificationMethod } from '@prisma/client';

import {
  VERIFICATION_VALID_FOR_MS,
  generateVerificationToken,
  instructionsFor,
  verificationIsStale,
  verifyOwnership,
  type VerificationTransport,
} from '@/lib/sites/verification';

const TOKEN = 'a-token-that-is-long-enough-to-be-real';

/**
 * DNS and HTTP are injected so these tests assert the verification logic
 * rather than the state of the internet. The transport itself is exercised
 * against the real network only in the integration suite.
 */
function transport(overrides: Partial<VerificationTransport> = {}): VerificationTransport {
  return {
    resolveTxt: () => Promise.reject(new Error('ENOTFOUND')),
    fetchChallengeFile: () => Promise.resolve(null),
    ...overrides,
  };
}

describe('generateVerificationToken', () => {
  it('produces distinct URL-safe tokens', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateVerificationToken()));
    expect(tokens.size).toBe(50);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('instructionsFor', () => {
  it('describes the DNS record to add', () => {
    const instructions = instructionsFor(
      'https://example.com',
      VerificationMethod.dns_txt,
      TOKEN,
    );
    expect(instructions.where).toBe('_bailey-challenge.example.com');
    expect(instructions.value).toBe(`bailey-site-verification=${TOKEN}`);
  });

  it('describes the file to serve', () => {
    const instructions = instructionsFor(
      'https://example.com',
      VerificationMethod.well_known_file,
      TOKEN,
    );
    expect(instructions.where).toBe('https://example.com/.well-known/bailey-challenge.txt');
    expect(instructions.value).toBe(TOKEN);
  });
});

describe('verifyOwnership by DNS TXT', () => {
  const publicOrigin = 'https://example.com';

  it('accepts a matching record', async () => {
    const result = await verifyOwnership(
      publicOrigin,
      VerificationMethod.dns_txt,
      TOKEN,
      transport({ resolveTxt: () => Promise.resolve([[`bailey-site-verification=${TOKEN}`]]) }),
    );
    expect(result.verified).toBe(true);
  });

  // Resolvers split TXT values on 255-byte boundaries; joining is required
  // before comparison or a long token never matches.
  it('joins the chunks a resolver splits a long record into', async () => {
    const result = await verifyOwnership(
      publicOrigin,
      VerificationMethod.dns_txt,
      TOKEN,
      transport({
        resolveTxt: () =>
          Promise.resolve([['bailey-site-verification=', TOKEN.slice(0, 10), TOKEN.slice(10)]]),
      }),
    );
    expect(result.verified).toBe(true);
  });

  it('finds the right record among unrelated ones', async () => {
    const result = await verifyOwnership(
      publicOrigin,
      VerificationMethod.dns_txt,
      TOKEN,
      transport({
        resolveTxt: () =>
          Promise.resolve([
            ['v=spf1 include:_spf.google.com ~all'],
            ['google-site-verification=something-else'],
            [`bailey-site-verification=${TOKEN}`],
          ]),
      }),
    );
    expect(result.verified).toBe(true);
  });

  it('rejects a record carrying the wrong token', async () => {
    const result = await verifyOwnership(
      publicOrigin,
      VerificationMethod.dns_txt,
      TOKEN,
      transport({ resolveTxt: () => Promise.resolve([['bailey-site-verification=wrong']]) }),
    );
    expect(result).toMatchObject({ verified: false });
    expect(result.verified === false && result.reason).toMatch(/does not contain the expected/);
  });

  it('rejects a bare token with no prefix', async () => {
    const result = await verifyOwnership(
      publicOrigin,
      VerificationMethod.dns_txt,
      TOKEN,
      transport({ resolveTxt: () => Promise.resolve([[TOKEN]]) }),
    );
    expect(result.verified).toBe(false);
  });

  it('reports a missing record as still propagating', async () => {
    const result = await verifyOwnership(
      publicOrigin,
      VerificationMethod.dns_txt,
      TOKEN,
      transport(),
    );
    expect(result.verified === false && result.reason).toMatch(/propagating/);
  });
});

describe('verifyOwnership by well-known file', () => {
  const publicOrigin = 'https://example.com';

  it('accepts a file containing the token', async () => {
    const result = await verifyOwnership(
      publicOrigin,
      VerificationMethod.well_known_file,
      TOKEN,
      transport({ fetchChallengeFile: () => Promise.resolve({ status: 200, body: TOKEN }) }),
    );
    expect(result.verified).toBe(true);
  });

  it('tolerates trailing whitespace a text editor adds', async () => {
    const result = await verifyOwnership(
      publicOrigin,
      VerificationMethod.well_known_file,
      TOKEN,
      transport({
        fetchChallengeFile: () => Promise.resolve({ status: 200, body: `${TOKEN}\n` }),
      }),
    );
    expect(result.verified).toBe(true);
  });

  /**
   * A redirect is the target telling us where to send the next request, which
   * is the exact primitive an SSRF guard exists to deny. The challenge must be
   * served at the address we asked for.
   */
  it('refuses to follow a redirect', async () => {
    const result = await verifyOwnership(
      publicOrigin,
      VerificationMethod.well_known_file,
      TOKEN,
      transport({ fetchChallengeFile: () => Promise.resolve({ status: 302, body: '' }) }),
    );
    expect(result).toMatchObject({ verified: false });
    expect(result.verified === false && result.reason).toMatch(/redirected/);
  });

  it('rejects a 404', async () => {
    const result = await verifyOwnership(
      publicOrigin,
      VerificationMethod.well_known_file,
      TOKEN,
      transport({ fetchChallengeFile: () => Promise.resolve({ status: 404, body: 'Not found' }) }),
    );
    expect(result.verified === false && result.reason).toMatch(/returned 404/);
  });

  it('rejects a page that merely mentions the token', async () => {
    const result = await verifyOwnership(
      publicOrigin,
      VerificationMethod.well_known_file,
      TOKEN,
      transport({
        fetchChallengeFile: () =>
          Promise.resolve({ status: 200, body: `<html><body>${TOKEN}</body></html>` }),
      }),
    );
    expect(result.verified).toBe(false);
  });

  it('reports an unreachable file rather than throwing', async () => {
    const result = await verifyOwnership(
      publicOrigin,
      VerificationMethod.well_known_file,
      TOKEN,
      transport(),
    );
    expect(result.verified === false && result.reason).toMatch(/could not be reached/);
  });
});

describe('verifyOwnership screening', () => {
  /**
   * A domain that was public when it was added may since have been repointed
   * at a private address. Verification re-screens rather than trusting the
   * check done at creation time.
   */
  it('refuses to verify a host that now resolves into a reserved range', async () => {
    const resolveTxt = vi.fn();
    const result = await verifyOwnership(
      'http://127.0.0.1',
      VerificationMethod.dns_txt,
      TOKEN,
      transport({ resolveTxt }),
    );

    expect(result).toMatchObject({ verified: false });
    expect(result.verified === false && result.reason).toMatch(/reserved address range/);
    // Screened before any lookup was attempted.
    expect(resolveTxt).not.toHaveBeenCalled();
  });
});

describe('verificationIsStale', () => {
  it('treats an unverified site as stale', () => {
    expect(verificationIsStale(null)).toBe(true);
  });

  it('is false inside the validity window', () => {
    const recent = new Date(Date.now() - VERIFICATION_VALID_FOR_MS / 2);
    expect(verificationIsStale(recent)).toBe(false);
  });

  it('is true past the validity window', () => {
    const old = new Date(Date.now() - VERIFICATION_VALID_FOR_MS - 1000);
    expect(verificationIsStale(old)).toBe(true);
  });
});
