import { randomBytes } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';

import { tokensMatch } from '@/lib/auth/session';
import { assertOriginIsPubliclyRoutable } from '@/lib/sites/origin';
import { VerificationMethod } from '@prisma/client';

/**
 * Proof of control over a domain, required before any scan is scheduled.
 *
 * Without it the platform is an open relay for scans: anyone could register,
 * point it at a third party, and have our infrastructure send the traffic.
 * That is an abuse vector, a source of complaints against our address space,
 * and in most jurisdictions it makes the operator a party to unauthorised
 * access. This is the control that makes the rest of the product defensible.
 *
 * Verification is re-checked periodically rather than once. A domain changes
 * hands, and continuing to scan for a customer who lost control of it is the
 * same problem arriving more slowly.
 */

const TXT_PREFIX = 'bailey-site-verification=';
const CHALLENGE_SUBDOMAIN = '_bailey-challenge';
const WELL_KNOWN_PATH = '/.well-known/bailey-challenge.txt';

/** Enough entropy that a token cannot be guessed, short enough to paste. */
export function generateVerificationToken(): string {
  return randomBytes(24).toString('base64url');
}

export interface VerificationInstructions {
  readonly method: VerificationMethod;
  readonly where: string;
  readonly value: string;
  readonly note: string;
}

export function instructionsFor(
  origin: string,
  method: VerificationMethod,
  token: string,
): VerificationInstructions {
  const { hostname } = new URL(origin);

  if (method === VerificationMethod.dns_txt) {
    return {
      method,
      where: `${CHALLENGE_SUBDOMAIN}.${hostname}`,
      value: `${TXT_PREFIX}${token}`,
      note:
        'Add this as a TXT record. DNS changes can take up to an hour to propagate, ' +
        'and the record must stay in place: it is re-checked periodically.',
    };
  }

  return {
    method,
    where: `${origin}${WELL_KNOWN_PATH}`,
    value: token,
    note:
      'Serve this file containing exactly the value shown. It must stay in place: it is ' +
      're-checked periodically.',
  };
}

export type VerificationOutcome =
  | { readonly verified: true; readonly method: VerificationMethod }
  | { readonly verified: false; readonly reason: string };

export interface VerificationTransport {
  resolveTxt(hostname: string): Promise<string[][]>;
  fetchChallengeFile(url: string): Promise<{ status: number; body: string } | null>;
}

/** Bounded so a hostile response cannot be used to exhaust the worker. */
const MAX_CHALLENGE_BYTES = 4096;
const FETCH_TIMEOUT_MS = 10_000;

export const defaultTransport: VerificationTransport = {
  resolveTxt: (hostname) => resolveTxt(hostname),

  async fetchChallengeFile(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        // Not following redirects is deliberate. A redirect is an instruction
        // from the target telling us where to send our next request, which is
        // exactly the primitive an SSRF guard exists to deny. The challenge
        // file has to be served at the address we asked for.
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: 'text/plain', 'user-agent': 'bailey-verification/1.0' },
      });

      const reader = response.body?.getReader();
      if (reader === undefined) return { status: response.status, body: '' };

      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done || value === undefined) break;
        total += value.byteLength;
        chunks.push(value);
        if (total >= MAX_CHALLENGE_BYTES) {
          await reader.cancel();
          break;
        }
      }

      return {
        status: response.status,
        body: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
          .subarray(0, MAX_CHALLENGE_BYTES)
          .toString('utf8'),
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  },
};

export async function verifyOwnership(
  origin: string,
  method: VerificationMethod,
  expectedToken: string,
  transport: VerificationTransport = defaultTransport,
): Promise<VerificationOutcome> {
  // Re-screened here as well as at creation: a domain's DNS may have been
  // repointed at a private address since the site was added.
  try {
    await assertOriginIsPubliclyRoutable(origin);
  } catch (error) {
    return {
      verified: false,
      reason: error instanceof Error ? error.message : 'The address could not be resolved.',
    };
  }

  return method === VerificationMethod.dns_txt
    ? verifyDnsTxt(origin, expectedToken, transport)
    : verifyWellKnownFile(origin, expectedToken, transport);
}

async function verifyDnsTxt(
  origin: string,
  expectedToken: string,
  transport: VerificationTransport,
): Promise<VerificationOutcome> {
  const { hostname } = new URL(origin);
  const name = `${CHALLENGE_SUBDOMAIN}.${hostname}`;

  let records: string[][];
  try {
    records = await transport.resolveTxt(name);
  } catch {
    return {
      verified: false,
      reason: `No TXT record found at ${name}. If you have just added it, DNS may still be propagating.`,
    };
  }

  // A TXT record arrives as an array of strings that the resolver split on
  // 255-byte boundaries; they have to be joined before comparison.
  const values = records.map((chunks) => chunks.join('').trim());

  for (const value of values) {
    if (!value.startsWith(TXT_PREFIX)) continue;
    if (tokensMatch(value.slice(TXT_PREFIX.length), expectedToken)) {
      return { verified: true, method: VerificationMethod.dns_txt };
    }
  }

  return {
    verified: false,
    reason:
      values.length === 0
        ? `No TXT record found at ${name}.`
        : `A TXT record exists at ${name} but does not contain the expected value.`,
  };
}

async function verifyWellKnownFile(
  origin: string,
  expectedToken: string,
  transport: VerificationTransport,
): Promise<VerificationOutcome> {
  const url = `${origin}${WELL_KNOWN_PATH}`;
  const response = await transport.fetchChallengeFile(url);

  if (response === null) {
    return { verified: false, reason: `${url} could not be reached.` };
  }

  if (response.status >= 300 && response.status < 400) {
    return {
      verified: false,
      reason:
        `${url} redirected. The challenge file must be served directly at that address, ` +
        'not through a redirect.',
    };
  }

  if (response.status !== 200) {
    return { verified: false, reason: `${url} returned ${response.status}.` };
  }

  return tokensMatch(response.body.trim(), expectedToken)
    ? { verified: true, method: VerificationMethod.well_known_file }
    : { verified: false, reason: `${url} was reachable but did not contain the expected value.` };
}

/**
 * How long a successful verification is trusted before it must be re-checked.
 * Scans continue during this window; past it, the site is re-verified before
 * the next scan is queued.
 */
export const VERIFICATION_VALID_FOR_MS = 30 * 24 * 60 * 60 * 1000;

export function verificationIsStale(checkedAt: Date | null, now: Date = new Date()): boolean {
  if (checkedAt === null) return true;
  return now.getTime() - checkedAt.getTime() > VERIFICATION_VALID_FOR_MS;
}
