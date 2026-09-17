'use server';

import { redirect } from 'next/navigation';

import { getCurrentSession, setSessionCookie } from '@/lib/auth/current-session';
import { describePasswordProblem, hashPassword } from '@/lib/auth/password';
import { createSession } from '@/lib/auth/session';
import { hashToken } from '@/lib/auth/session';
import { administrativeDb, withoutTenantScope } from '@/lib/db/tenant';
import { formString } from '@/lib/forms';

function back(token: string, message: string): never {
  redirect(`/invitations/${token}?error=${encodeURIComponent(message)}`);
}

/**
 * Looks an invitation up by its raw token.
 *
 * Goes through the owner connection, not a tenant-scoped one: the whole point
 * of this lookup is to discover which organisation a token belongs to, so no
 * organisation context can exist yet for row-level security to be scoped to.
 * The same narrow, considered exception as resolving a slug in
 * requireMembership() -- an invitation row keyed by a token nobody could have
 * without receiving the invitation is not exposed more broadly by this read.
 */
async function findLiveInvitation(token: string) {
  const invitation = await administrativeDb.invitation.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { organisation: { select: { id: true, name: true, slug: true, deletedAt: true } } },
  });

  if (
    invitation === null ||
    invitation.revokedAt !== null ||
    invitation.acceptedAt !== null ||
    invitation.expiresAt.getTime() <= Date.now() ||
    invitation.organisation.deletedAt !== null
  ) {
    return null;
  }
  return invitation;
}

export async function acceptInvitationAction(formData: FormData): Promise<void> {
  const token = formString(formData, 'token');
  const invitation = await findLiveInvitation(token);
  if (invitation === null) back(token, 'This invitation is no longer valid.');

  const session = await getCurrentSession();

  if (session !== null) {
    if (session.user.email !== invitation.email) {
      back(
        token,
        `This invitation is for ${invitation.email}. Sign out and try again with that account.`,
      );
    }

    await administrativeDb.$transaction([
      administrativeDb.membership.upsert({
        where: {
          organisationId_userId: { organisationId: invitation.organisationId, userId: session.user.id },
        },
        create: { organisationId: invitation.organisationId, userId: session.user.id, role: invitation.role },
        update: { role: invitation.role },
      }),
      administrativeDb.invitation.update({
        where: { id: invitation.id },
        data: { acceptedAt: new Date() },
      }),
    ]);

    redirect(`/o/${invitation.organisation.slug}`);
  }

  // No session: this is a new person. Create their account from the name and
  // password on this form, tied to the email the invitation was sent to --
  // not one they type -- so accepting an invitation can never grant access
  // to an address the inviter did not choose.
  const name = formString(formData, 'name').trim();
  const password = formString(formData, 'password');

  const existing = await withoutTenantScope((db) => db.user.findUnique({ where: { email: invitation.email } }));
  if (existing !== null) {
    back(token, 'An account already exists for this email. Sign in first, then open this link again.');
  }

  if (name === '') back(token, 'Enter your name.');
  const passwordProblem = describePasswordProblem(password);
  if (passwordProblem !== undefined) back(token, passwordProblem);

  const passwordHash = await hashPassword(password);
  const user = await withoutTenantScope((db) =>
    db.user.create({ data: { email: invitation.email, name, passwordHash } }),
  );

  await administrativeDb.$transaction([
    administrativeDb.membership.create({
      data: { organisationId: invitation.organisationId, userId: user.id, role: invitation.role },
    }),
    administrativeDb.invitation.update({ where: { id: invitation.id }, data: { acceptedAt: new Date() } }),
  ]);

  const { token: sessionToken, session: newSession } = await createSession(user.id);
  await setSessionCookie(sessionToken, newSession.expiresAt);

  redirect(`/o/${invitation.organisation.slug}`);
}
