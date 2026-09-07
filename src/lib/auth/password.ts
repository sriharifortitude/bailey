import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id at the OWASP-recommended second configuration: 19 MiB of memory,
 * two iterations, one degree of parallelism.
 *
 * Memory cost is the parameter that matters against GPU and ASIC attackers,
 * which is why it is high relative to the iteration count. These are recorded
 * as named constants rather than inlined because raising them later is a
 * deliberate operational decision -- existing hashes carry their own
 * parameters, so old passwords keep verifying and are re-hashed on next login.
 */
const ARGON2_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Argon2id hash of a value that is not a password, used to spend the same time
 * verifying a login for an address that has no account as for one that does.
 * Without it, response time discloses whether an email is registered, which is
 * a user enumeration primitive and a GDPR problem as much as a security one.
 *
 * Computed once, lazily, because it costs the same as a real hash.
 */
let absentUserHash: string | undefined;

async function dummyHash(): Promise<string> {
  absentUserHash ??= await hash('bailey/no-such-user', ARGON2_OPTIONS);
  return absentUserHash;
}

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

/**
 * Verifies a password against a stored hash.
 *
 * Pass `undefined` when no user was found, or when the user has no password
 * set: the work is still done against a dummy hash so the timing does not
 * differ. Callers must not skip this call on the "no such user" path.
 */
export async function verifyPassword(
  storedHash: string | null | undefined,
  password: string,
): Promise<boolean> {
  if (storedHash === null || storedHash === undefined) {
    await verify(await dummyHash(), password).catch(() => false);
    return false;
  }

  try {
    return await verify(storedHash, password);
  } catch {
    // A malformed or truncated hash is a corrupt record, not a valid login.
    return false;
  }
}

/**
 * True when a stored hash was produced with weaker parameters than the current
 * ones, so the caller can transparently re-hash on a successful login.
 */
export function needsRehash(storedHash: string): boolean {
  const memory = /\bm=(\d+)/.exec(storedHash);
  const time = /\bt=(\d+)/.exec(storedHash);
  if (memory?.[1] === undefined || time?.[1] === undefined) return true;

  return (
    Number(memory[1]) < ARGON2_OPTIONS.memoryCost || Number(time[1]) < ARGON2_OPTIONS.timeCost
  );
}

/**
 * Minimum viable policy: length, and nothing else.
 *
 * Composition rules (one upper, one digit, one symbol) push people towards
 * Password1! and are explicitly discouraged by NIST SP 800-63B. Length is the
 * parameter that carries the entropy. The 72-byte ceiling is not an argon2
 * limit -- it exists so a very long input cannot be used to make the hash
 * function itself the expensive part of a request.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_BYTES = 1024;

export function describePasswordProblem(password: string): string | undefined {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    return 'Password is too long.';
  }
  return undefined;
}
