import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  SESSION_IDLE_TIMEOUT_MS,
  createSession,
  hashToken,
  purgeExpiredSessions,
  resolveSession,
  revokeAllSessionsForUser,
  revokeSession,
  rotateSession,
} from '@/lib/auth/session';
import { administrativeDb, disconnect } from '@/lib/db/tenant';
import { resetDatabase, seedOrganisation, type SeededOrganisation } from '../helpers/fixtures';

describe('session lifecycle', () => {
  let org: SeededOrganisation;

  beforeEach(async () => {
    await resetDatabase();
    org = await seedOrganisation('alpha');
  });

  afterAll(async () => {
    await disconnect();
  });

  it('resolves a freshly issued token to its user', async () => {
    const { token } = await createSession(org.ownerUserId, {
      userAgent: 'Mozilla/5.0',
      ip: '203.0.113.42',
    });

    const resolved = await resolveSession(token);
    expect(resolved?.user.id).toBe(org.ownerUserId);
    expect(resolved?.session.userAgent).toBe('Mozilla/5.0');
    // Truncated on the way in.
    expect(resolved?.session.ipPrefix).toBe('203.0.113.0');
  });

  // A dump of the sessions table must not be a set of usable credentials.
  it('never stores the token itself', async () => {
    const { token } = await createSession(org.ownerUserId);

    const rows = await administrativeDb.session.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it.each([undefined, '', 'not-a-real-token'])('rejects the token %s', async (token) => {
    await expect(resolveSession(token)).resolves.toBeNull();
  });

  it('rejects an expired session and removes the row', async () => {
    const { token, session } = await createSession(org.ownerUserId);
    await administrativeDb.session.update({
      where: { id: session.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(resolveSession(token)).resolves.toBeNull();
    expect(await administrativeDb.session.count()).toBe(0);
  });

  it('rejects a session that has been idle past the timeout', async () => {
    const { token, session } = await createSession(org.ownerUserId);
    await administrativeDb.session.update({
      where: { id: session.id },
      data: { lastSeenAt: new Date(Date.now() - SESSION_IDLE_TIMEOUT_MS - 1000) },
    });

    await expect(resolveSession(token)).resolves.toBeNull();
  });

  it('keeps a session that is within the idle window', async () => {
    const { token, session } = await createSession(org.ownerUserId);
    await administrativeDb.session.update({
      where: { id: session.id },
      data: { lastSeenAt: new Date(Date.now() - SESSION_IDLE_TIMEOUT_MS + 60_000) },
    });

    await expect(resolveSession(token)).resolves.not.toBeNull();
  });

  // Rotation on privilege change: a token an attacker fixed beforehand must
  // stop working.
  it('invalidates the old token when a session is rotated', async () => {
    const { token: original } = await createSession(org.ownerUserId);

    const rotated = await rotateSession(original);
    expect(rotated).not.toBeNull();
    expect(rotated!.token).not.toBe(original);

    await expect(resolveSession(original)).resolves.toBeNull();
    await expect(resolveSession(rotated!.token)).resolves.not.toBeNull();
  });

  it('does not rotate an invalid session into a valid one', async () => {
    await expect(rotateSession('nonsense')).resolves.toBeNull();
    expect(await administrativeDb.session.count()).toBe(0);
  });

  it('revokes a single session without touching the others', async () => {
    const first = await createSession(org.ownerUserId);
    const second = await createSession(org.ownerUserId);

    await revokeSession(first.token);

    await expect(resolveSession(first.token)).resolves.toBeNull();
    await expect(resolveSession(second.token)).resolves.not.toBeNull();
  });

  // The password-change path: sign out every other device, stay signed in here.
  it('revokes every session except the current one', async () => {
    const current = await createSession(org.ownerUserId);
    await createSession(org.ownerUserId);
    await createSession(org.ownerUserId);

    const removed = await revokeAllSessionsForUser(org.ownerUserId, {
      exceptToken: current.token,
    });

    expect(removed).toBe(2);
    await expect(resolveSession(current.token)).resolves.not.toBeNull();
    expect(await administrativeDb.session.count()).toBe(1);
  });

  it('rejects and clears sessions for a user pending erasure', async () => {
    const { token } = await createSession(org.ownerUserId);
    await createSession(org.ownerUserId);

    await administrativeDb.user.update({
      where: { id: org.ownerUserId },
      data: { deletedAt: new Date() },
    });

    await expect(resolveSession(token)).resolves.toBeNull();
    // Not just this one -- every session the user held.
    expect(await administrativeDb.session.count()).toBe(0);
  });

  it('purges only sessions past their absolute expiry', async () => {
    const live = await createSession(org.ownerUserId);
    const dead = await createSession(org.ownerUserId);
    await administrativeDb.session.update({
      where: { id: dead.session.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    expect(await purgeExpiredSessions()).toBe(1);
    await expect(resolveSession(live.token)).resolves.not.toBeNull();
  });

  it('issues a distinct token every time', async () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      tokens.add((await createSession(org.ownerUserId)).token);
    }
    expect(tokens.size).toBe(20);
  });
});
