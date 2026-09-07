import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Origin parsing and reachability screening.
 *
 * The platform sends requests to hostnames supplied by its users, from
 * infrastructure that sits inside a private network. That is a server-side
 * request forgery primitive unless the address a hostname resolves to is
 * screened, so it is screened here before anything is queued.
 *
 * The scanner has its own guard, and this is not redundant with it: a rejection
 * that happens when a site is added is a form validation error the user can
 * act on, whereas one that happens inside a worker is a failed job nobody
 * reads. Both layers exist, and defence in depth is the point.
 */

export class InvalidOriginError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'InvalidOriginError';
  }
}

const RESERVED_IPV4: ReadonlyArray<readonly [string, number, string]> = [
  ['0.0.0.0', 8, 'this network'],
  ['10.0.0.0', 8, 'private use'],
  ['100.64.0.0', 10, 'carrier-grade NAT'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local'],
  ['172.16.0.0', 12, 'private use'],
  ['192.0.0.0', 24, 'protocol assignments'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.168.0.0', 16, 'private use'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
];

const RESERVED_IPV6: ReadonlyArray<readonly [string, number, string]> = [
  ['::', 128, 'unspecified'],
  ['::1', 128, 'loopback'],
  ['fc00::', 7, 'unique local'],
  ['fe80::', 10, 'link-local'],
  ['ff00::', 8, 'multicast'],
];

function ipv4ToInt(address: string): number {
  const octets = address.split('.');
  if (octets.length !== 4) throw new TypeError(`not IPv4: ${address}`);

  let value = 0;
  for (const octet of octets) {
    const part = Number(octet);
    if (!Number.isInteger(part) || part < 0 || part > 255) {
      throw new TypeError(`not IPv4: ${address}`);
    }
    value = value * 256 + part;
  }
  return value;
}

function ipv6ToBigInt(address: string): bigint {
  const zoneless = address.split('%')[0] ?? address;

  // ::ffff:192.0.2.1 carries a v4 address in the low 32 bits.
  const embedded = /^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(zoneless);
  const text =
    embedded?.[1] !== undefined && embedded[2] !== undefined
      ? `${embedded[1]}${((ipv4ToInt(embedded[2]) >>> 16) & 0xffff).toString(16)}:${(
          ipv4ToInt(embedded[2]) & 0xffff
        ).toString(16)}`
      : zoneless;

  const halves = text.split('::');
  if (halves.length > 2) throw new TypeError(`not IPv6: ${address}`);

  const head = (halves[0] ?? '') === '' ? [] : (halves[0] ?? '').split(':');
  let groups: string[];

  if (halves.length === 1) {
    groups = head;
  } else {
    const tailText = halves[1] ?? '';
    const tail = tailText === '' ? [] : tailText.split(':');
    const fill = 8 - head.length - tail.length;
    if (fill < 0) throw new TypeError(`not IPv6: ${address}`);
    groups = [...head, ...Array<string>(fill).fill('0'), ...tail];
  }
  if (groups.length !== 8) throw new TypeError(`not IPv6: ${address}`);

  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) throw new TypeError(`not IPv6: ${address}`);
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

/** Human-readable reason when an address is reserved, otherwise undefined. */
export function reservedRangeFor(address: string): string | undefined {
  const family = isIP(address);

  try {
    if (family === 4) {
      for (const [base, prefix, label] of RESERVED_IPV4) {
        const mask = prefix === 0 ? 0 : (-1 << (32 - prefix)) >>> 0;
        if (((ipv4ToInt(address) & mask) >>> 0) === ((ipv4ToInt(base) & mask) >>> 0)) return label;
      }
      return address === '255.255.255.255' ? 'broadcast' : undefined;
    }

    if (family === 6) {
      const mapped = /^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/i.exec(address);
      if (mapped?.[1] !== undefined) return reservedRangeFor(mapped[1]);

      for (const [base, prefix, label] of RESERVED_IPV6) {
        const shift = BigInt(128 - prefix);
        if (ipv6ToBigInt(address) >> shift === ipv6ToBigInt(base) >> shift) return label;
      }
      return undefined;
    }
  } catch {
    return 'unparseable address';
  }

  return 'unparseable address';
}

/**
 * Normalises user input to a canonical https origin.
 *
 * A site's identity is its origin, not a URL: paths, query strings and
 * fragments are discarded rather than rejected, because "https://x.com/en/home"
 * is what a person pastes when they mean the site at x.com. The unique
 * constraint on (organisationId, origin) then behaves the way a user expects.
 */
export function normaliseOrigin(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '') throw new InvalidOriginError('Enter a website address.');

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new InvalidOriginError(`"${input}" is not a valid website address.`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new InvalidOriginError(
      `"${url.protocol}" addresses cannot be monitored.`,
      'Enter an http:// or https:// address.',
    );
  }

  if (url.username !== '' || url.password !== '') {
    throw new InvalidOriginError(
      'Remove the username and password from the address.',
      'Credentials in a URL would be stored and shown in reports.',
    );
  }

  if (url.hostname === '') throw new InvalidOriginError('Enter a website address.');

  // A hostname with no dot is either a local machine name or a typo; neither
  // is something an agency monitors for a client.
  if (isIP(url.hostname) === 0 && !url.hostname.includes('.')) {
    throw new InvalidOriginError(
      `"${url.hostname}" does not look like a public website address.`,
      'Enter a full domain, for example example.com.',
    );
  }

  return url.origin;
}

export interface ReachabilityResult {
  readonly addresses: readonly string[];
}

/**
 * Resolves the origin and rejects it if any address is in a reserved range.
 *
 * Every resolved address is checked, not just the first: a hostname with one
 * public and one loopback A record would otherwise pass and then be reachable
 * on the private one.
 */
export async function assertOriginIsPubliclyRoutable(
  origin: string,
  resolver: (hostname: string) => Promise<Array<{ address: string }>> = (hostname) =>
    lookup(hostname, { all: true }),
): Promise<ReachabilityResult> {
  const { hostname } = new URL(origin);

  if (isIP(hostname) !== 0) {
    const reason = reservedRangeFor(hostname);
    if (reason !== undefined) {
      throw new InvalidOriginError(
        `${hostname} is in a reserved address range (${reason}).`,
        'Only publicly reachable websites can be monitored.',
      );
    }
    return { addresses: [hostname] };
  }

  let records: Array<{ address: string }>;
  try {
    records = await resolver(hostname);
  } catch {
    throw new InvalidOriginError(
      `${hostname} could not be resolved.`,
      'Check the address, and that the domain has a DNS record.',
    );
  }

  if (records.length === 0) {
    throw new InvalidOriginError(`${hostname} did not resolve to any address.`);
  }

  for (const { address } of records) {
    const reason = reservedRangeFor(address);
    if (reason !== undefined) {
      throw new InvalidOriginError(
        `${hostname} resolves to ${address}, which is in a reserved address range (${reason}).`,
        'Only publicly reachable websites can be monitored.',
      );
    }
  }

  return { addresses: records.map((record) => record.address) };
}
