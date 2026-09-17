import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import type { Role } from '@prisma/client';

import { SESSION_COOKIE, SESSION_COOKIE_OPTIONS } from '@/lib/auth/cookies';
import { resolveSession, type AuthenticatedSession } from '@/lib/auth/session';
import { administrativeDb, withUser, type RequestContext } from '@/lib/db/tenant';

/**
 * Reads and validates the session cookie for the current request. Returns
 * null rather than throwing, since an anonymous visitor to a public route is
 * an expected case, not an error.
 */
export async function getCurrentSession(): Promise<AuthenticatedSession | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  return resolveSession(token);
}

export async function requireSession(): Promise<AuthenticatedSession> {
  const session = await getCurrentSession();
  if (session === null) redirect('/login');
  return session;
}

export interface MembershipContext {
  readonly organisation: { readonly id: string; readonly name: string; readonly slug: string };
  readonly role: Role;
  readonly context: RequestContext;
  readonly user: AuthenticatedSession['user'];
}

/**
 * Resolves an org-scoped route: confirms the caller is signed in, that the
 * organisation named in the URL exists, and that the caller belongs to it.
 *
 * The organisation lookup by slug goes through the owner connection rather
 * than a tenant-scoped one. That is deliberate, not a shortcut: resolving a
 * slug to an id is exactly the chicken-and-egg case row-level security can't
 * cover on its own -- the organisation context that unlocks the policy is the
 * thing we are still trying to find. A slug and a name are not tenant
 * secrets, so this is a narrow, considered exception, not a bypass; every
 * subsequent read for this request goes through withOrganisation() once
 * membership is confirmed below.
 */
export async function requireMembership(orgSlug: string): Promise<MembershipContext> {
  const session = await requireSession();

  const organisation = await administrativeDb.organisation.findUnique({
    where: { slug: orgSlug, deletedAt: null },
    select: { id: true, name: true, slug: true },
  });
  if (organisation === null) notFound();

  // Membership's row-level security policy allows a row where userId matches
  // the caller regardless of which organisation is selected, which is what
  // makes this check possible before an organisation context exists.
  const membership = await withUser(session.user.id, (db) =>
    db.membership.findUnique({
      where: { organisationId_userId: { organisationId: organisation.id, userId: session.user.id } },
      select: { role: true },
    }),
  );
  if (membership === null) redirect('/select-org');

  return {
    organisation,
    role: membership.role,
    context: { userId: session.user.id, organisationId: organisation.id },
    user: session.user,
  };
}

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, { ...SESSION_COOKIE_OPTIONS, expires: expiresAt });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}
