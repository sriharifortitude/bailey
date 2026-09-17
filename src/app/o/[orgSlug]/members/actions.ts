'use server';

import { redirect } from 'next/navigation';
import { randomBytes } from 'node:crypto';
import { Role } from '@prisma/client';

import { requireMembership } from '@/lib/auth/current-session';
import { withOrganisation } from '@/lib/db/tenant';
import { assertCan, canGrantRole, canManageMember, wouldRemoveLastOwner } from '@/lib/policy/rbac';
import { hashToken } from '@/lib/auth/session';
import { formString } from '@/lib/forms';

function back(orgSlug: string, message: string, kind: 'error' | 'success' = 'error'): never {
  const param = kind === 'error' ? 'error' : 'success';
  redirect(`/o/${orgSlug}/members?${param}=${encodeURIComponent(message)}`);
}

function parseRole(raw: FormDataEntryValue | null): Role {
  const value = typeof raw === 'string' ? raw : '';
  if (value === Role.admin || value === Role.member || value === Role.viewer) return value;
  return Role.viewer;
}

const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export async function inviteMemberAction(formData: FormData): Promise<void> {
  const orgSlug = formString(formData, 'orgSlug');
  const { role, context, user } = await requireMembership(orgSlug);
  assertCan(role, 'member:invite');

  const email = formString(formData, 'email').trim().toLowerCase();
  const invitedRole = parseRole(formData.get('role'));

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) back(orgSlug, 'Enter a valid email address.');
  if (!canGrantRole(role, invitedRole)) back(orgSlug, 'You cannot invite someone to that role.');

  const token = randomBytes(24).toString('base64url');

  await withOrganisation(context, (db) =>
    db.invitation.upsert({
      where: { organisationId_email: { organisationId: context.organisationId, email } },
      create: {
        organisationId: context.organisationId,
        email,
        role: invitedRole,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + INVITATION_LIFETIME_MS),
        invitedByUserId: user.id,
      },
      // Re-inviting replaces the previous, still-pending invitation rather
      // than creating a second one for the same address.
      update: {
        role: invitedRole,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + INVITATION_LIFETIME_MS),
        invitedByUserId: user.id,
        revokedAt: null,
        acceptedAt: null,
      },
    }),
  );

  // No email delivery is wired up yet (see README limitations); the token is
  // surfaced directly so the flow is usable end to end during review.
  back(orgSlug, `Invitation link: /invitations/${token}`, 'success');
}

export async function revokeInvitationAction(formData: FormData): Promise<void> {
  const orgSlug = formString(formData, 'orgSlug');
  const invitationId = formString(formData, 'invitationId');
  const { role, context } = await requireMembership(orgSlug);
  assertCan(role, 'member:invite');

  await withOrganisation(context, (db) =>
    db.invitation.update({ where: { id: invitationId }, data: { revokedAt: new Date() } }),
  );

  back(orgSlug, 'Invitation revoked.', 'success');
}

export async function changeMemberRoleAction(formData: FormData): Promise<void> {
  const orgSlug = formString(formData, 'orgSlug');
  const membershipId = formString(formData, 'membershipId');
  const { role, context } = await requireMembership(orgSlug);
  assertCan(role, 'member:change_role');

  const newRole = parseRole(formData.get('role'));
  const target = await withOrganisation(context, (db) =>
    db.membership.findUniqueOrThrow({ where: { id: membershipId } }),
  );

  if (!canManageMember(role, target.role) && target.role !== newRole) {
    back(orgSlug, 'You cannot change that member’s role.');
  }
  if (!canGrantRole(role, newRole)) back(orgSlug, 'You cannot grant that role.');

  const allMembers = await withOrganisation(context, (db) =>
    db.membership.findMany({ select: { userId: true, role: true } }),
  );
  if (wouldRemoveLastOwner(allMembers, { userId: target.userId, newRole })) {
    back(orgSlug, 'An organisation must always have at least one owner.');
  }

  await withOrganisation(context, (db) =>
    db.membership.update({ where: { id: membershipId }, data: { role: newRole } }),
  );

  back(orgSlug, 'Role updated.', 'success');
}

export async function removeMemberAction(formData: FormData): Promise<void> {
  const orgSlug = formString(formData, 'orgSlug');
  const membershipId = formString(formData, 'membershipId');
  const { role, context } = await requireMembership(orgSlug);
  assertCan(role, 'member:remove');

  const target = await withOrganisation(context, (db) =>
    db.membership.findUniqueOrThrow({ where: { id: membershipId } }),
  );

  if (!canManageMember(role, target.role)) back(orgSlug, 'You cannot remove that member.');

  const allMembers = await withOrganisation(context, (db) =>
    db.membership.findMany({ select: { userId: true, role: true } }),
  );
  if (wouldRemoveLastOwner(allMembers, { userId: target.userId, newRole: null })) {
    back(orgSlug, 'An organisation must always have at least one owner.');
  }

  await withOrganisation(context, (db) => db.membership.delete({ where: { id: membershipId } }));

  back(orgSlug, 'Member removed.', 'success');
}
