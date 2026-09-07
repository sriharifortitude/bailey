import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { withoutTenantScope } from '@/lib/db/tenant';
import type { Session, User } from '@prisma/client';

/**
 * Opaque session tokens, stored as a hash.
 *
 * The token is 32 bytes from the CSPRNG. It carries no claims, so there is
 * nothing in it to tamper with and nothing to sign -- validity is decided by a
 * database lookup, which also means a session can be revoked immediately.
 * See docs/adr/0002-sessions-not-jwts.md for why not JWTs.
 *
 * Only the SHA-256 of the token is persisted. A dump of the sessions table is
 * therefore not a set of usable credentials. SHA-256 rather than argon2 is
 * deliberate: the input already has 256 bits of entropy, so there is no
 * dictionary to slow down, and session validation happens on every request.
 */

const TOKEN_BYTES = 32;

/** Absolute lifetime. A session cannot outlive this regardless of activity. */
export const SESSION_ABSOLUTE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/** Idle timeout: a session unused for this long is treated as expired. */
export const SESSION_IDLE_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * lastSeenAt is only written when it is this stale, so an active session does
 * not cause a database write on every single request.
 */
const LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60 * 1000;

export interface IssuedSession {
  /** Returned to the caller once, to be placed in the cookie. Never stored. */
  readonly token: string;
  readonly session: Session;
}

export interface AuthenticatedSession {
  readonly session: Session;
  readonly user: User;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface SessionMetadata {
  readonly userAgent?: string | undefined;
  readonly ip?: string | undefined;
}

/**
 * IP addresses are stored truncated: the first three octets of IPv4, the first
 * 48 bits of IPv6. Enough for a user to recognise "this was me, at the office"
 * in the active sessions list, not enough to be a location history. GDPR data
 * minimisation is the reason, and it costs nothing.
 */
export function truncateIp(ip: string | undefined): string | undefined {
  if (ip === undefined || ip === '') return undefined;

  if (ip.includes(':')) {
    const groups = ip.split(':').filter((group) => group !== '');
    return groups.length >= 3 ? `${groups.slice(0, 3).join(':')}::` : undefined;
  }

  const octets = ip.split('.');
  return octets.length === 4 ? `${octets.slice(0, 3).join('.')}.0` : undefined;
}

export async function createSession(
  userId: string,
  metadata: SessionMetadata = {},
): Promise<IssuedSession> {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_ABSOLUTE_LIFETIME_MS);
  const ipPrefix = truncateIp(metadata.ip);

  const session = await withoutTenantScope((db) =>
    db.session.create({
      data: {
        tokenHash: hashToken(token),
        userId,
        expiresAt,
        // Bounded so a hostile header cannot bloat the row.
        ...(metadata.userAgent === undefined
          ? {}
          : { userAgent: metadata.userAgent.slice(0, 256) }),
        ...(ipPrefix === undefined ? {} : { ipPrefix }),
      },
    }),
  );

  return { token, session };
}

/**
 * Resolves a token to its session and user, or null.
 *
 * Returns null for expired, idle-timed-out, and soft-deleted users, and
 * deletes the row on the way out so expired sessions do not accumulate.
 */
export async function resolveSession(
  token: string | undefined,
): Promise<AuthenticatedSession | null> {
  if (token === undefined || token === '') return null;

  const tokenHash = hashToken(token);

  return withoutTenantScope(async (db) => {
    const session = await db.session.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (session === null) return null;

    const now = Date.now();
    const expired = session.expiresAt.getTime() <= now;
    const idle = now - session.lastSeenAt.getTime() > SESSION_IDLE_TIMEOUT_MS;

    if (expired || idle) {
      await db.session.delete({ where: { id: session.id } }).catch(() => undefined);
      return null;
    }

    // A user pending erasure keeps no valid sessions.
    if (session.user.deletedAt !== null) {
      await db.session.deleteMany({ where: { userId: session.userId } });
      return null;
    }

    if (now - session.lastSeenAt.getTime() > LAST_SEEN_WRITE_INTERVAL_MS) {
      await db.session.update({
        where: { id: session.id },
        data: { lastSeenAt: new Date(now) },
      });
    }

    const { user, ...rest } = session;
    return { session: rest, user };
  });
}

/**
 * Issues a new token for an existing session and invalidates the old one.
 *
 * Called on privilege change -- password change, role elevation, accepting an
 * invitation. If an attacker fixed a token before the change, rotation makes
 * the one they hold useless.
 */
export async function rotateSession(
  currentToken: string,
  metadata: SessionMetadata = {},
): Promise<IssuedSession | null> {
  const existing = await resolveSession(currentToken);
  if (existing === null) return null;

  await revokeSession(currentToken);
  return createSession(existing.user.id, metadata);
}

export async function revokeSession(token: string): Promise<void> {
  await withoutTenantScope((db) =>
    db.session.deleteMany({ where: { tokenHash: hashToken(token) } }),
  );
}

/** Used on password change: every other device is signed out. */
export async function revokeAllSessionsForUser(
  userId: string,
  options: { readonly exceptToken?: string } = {},
): Promise<number> {
  const keep = options.exceptToken === undefined ? undefined : hashToken(options.exceptToken);

  const result = await withoutTenantScope((db) =>
    db.session.deleteMany({
      where: { userId, ...(keep === undefined ? {} : { NOT: { tokenHash: keep } }) },
    }),
  );
  return result.count;
}

/** Removes sessions that are past their absolute expiry. Run on a schedule. */
export async function purgeExpiredSessions(): Promise<number> {
  const result = await withoutTenantScope((db) =>
    db.session.deleteMany({ where: { expiresAt: { lte: new Date() } } }),
  );
  return result.count;
}

/**
 * Constant-time comparison for tokens that are compared directly rather than
 * looked up -- CSRF tokens, invitation tokens. Length is not secret, so an
 * early return on mismatched length is fine.
 */
export function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
