import { describe, expect, it } from 'vitest';

import {
  PASSWORD_MIN_LENGTH,
  describePasswordProblem,
  hashPassword,
  needsRehash,
  verifyPassword,
} from '@/lib/auth/password';

describe('hashPassword / verifyPassword', () => {
  it('verifies a correct password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    await expect(verifyPassword(stored, 'correct horse battery staple')).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    await expect(verifyPassword(stored, 'Correct horse battery staple')).resolves.toBe(false);
  });

  it('produces a different hash for the same password each time', async () => {
    const [a, b] = await Promise.all([hashPassword('same input'), hashPassword('same input')]);
    expect(a).not.toBe(b);
    await expect(verifyPassword(a, 'same input')).resolves.toBe(true);
    await expect(verifyPassword(b, 'same input')).resolves.toBe(true);
  });

  it('uses argon2id', async () => {
    expect(await hashPassword('x'.repeat(12))).toMatch(/^\$argon2id\$/);
  });

  // The no-such-user path must still do the work, or response time discloses
  // whether an address is registered.
  it.each([null, undefined])('returns false without throwing for a %s hash', async (stored) => {
    await expect(verifyPassword(stored, 'anything')).resolves.toBe(false);
  });

  it('returns false for a corrupt stored hash rather than throwing', async () => {
    await expect(verifyPassword('not-a-hash', 'anything')).resolves.toBe(false);
    await expect(verifyPassword('$argon2id$v=19$m=1', 'anything')).resolves.toBe(false);
  });
});

describe('needsRehash', () => {
  it('is false for a hash produced with the current parameters', async () => {
    expect(needsRehash(await hashPassword('a'.repeat(12)))).toBe(false);
  });

  it('is true for weaker parameters', () => {
    expect(needsRehash('$argon2id$v=19$m=4096,t=1,p=1$c2FsdA$aGFzaA')).toBe(true);
  });

  it('is true for anything it cannot parse, so the password is upgraded', () => {
    expect(needsRehash('$2b$12$something')).toBe(true);
    expect(needsRehash('')).toBe(true);
  });
});

describe('describePasswordProblem', () => {
  it('rejects passwords under the minimum length', () => {
    expect(describePasswordProblem('a'.repeat(PASSWORD_MIN_LENGTH - 1))).toMatch(/at least/);
  });

  it('accepts a password at the minimum length', () => {
    expect(describePasswordProblem('a'.repeat(PASSWORD_MIN_LENGTH))).toBeUndefined();
  });

  // Composition rules push people towards Password1! and are discouraged by
  // NIST SP 800-63B, so a long all-lowercase passphrase is fine.
  it('does not impose composition rules', () => {
    expect(describePasswordProblem('all lowercase and quite long indeed')).toBeUndefined();
  });

  it('rejects an input long enough to make hashing the expensive part', () => {
    expect(describePasswordProblem('a'.repeat(2000))).toMatch(/too long/);
  });
});
