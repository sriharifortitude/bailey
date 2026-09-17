import { Role } from '@prisma/client';

import { administrativeDb } from '@/lib/db/tenant';

export class ErasureBlockedError extends Error {
  constructor(readonly organisationNames: readonly string[]) {
    super(
      `Cannot erase this account while it is the sole owner of: ${organisationNames.join(', ')}. ` +
        'Transfer ownership or delete those organisations first.',
    );
    this.name = 'ErasureBlockedError';
  }
}

/**
 * Erases one user's personal data: an Article 17 "right to be forgotten"
 * request.
 *
 * The user row is soft-deleted rather than removed, deliberately. Findings,
 * audit events and issue events reference it (assignedToUserId, actorUserId),
 * and losing "who did this" from an organisation's audit trail on request of
 * the person who did it is the wrong trade -- the organisation's own
 * accountability record should not depend on a former member's erasure
 * request. What actually changes on erasure: the fields that identify the
 * person -- name, email, password -- are overwritten, every session is
 * revoked, and every membership is removed so access ends immediately.
 * Foreign keys that referenced this user keep resolving to a row that no
 * longer carries anything personal.
 *
 * Blocked when the user is the sole owner of an organisation: erasing them
 * would either delete that organisation's data as a side effect of someone
 * else's request, or leave the organisation ownerless. Both are the wrong
 * default; the person has to resolve that first.
 */
export async function eraseUserPersonalData(userId: string): Promise<void> {
  const ownedOrganisations = await administrativeDb.membership.findMany({
    where: { userId, role: Role.owner },
    include: { organisation: { select: { id: true, name: true } } },
  });

  const soleOwnerOf: string[] = [];
  for (const membership of ownedOrganisations) {
    const otherOwners = await administrativeDb.membership.count({
      where: { organisationId: membership.organisationId, role: Role.owner, userId: { not: userId } },
    });
    if (otherOwners === 0) soleOwnerOf.push(membership.organisation.name);
  }
  if (soleOwnerOf.length > 0) throw new ErasureBlockedError(soleOwnerOf);

  const placeholder = `erased-${userId}@deleted.invalid`;

  await administrativeDb.$transaction([
    administrativeDb.session.deleteMany({ where: { userId } }),
    administrativeDb.membership.deleteMany({ where: { userId } }),
    administrativeDb.issue.updateMany({
      where: { assignedToUserId: userId },
      data: { assignedToUserId: null },
    }),
    // Invitations sent by this user are left alone: invitedByUserId is
    // required and has no SET NULL relation, so a pending invitation stays
    // attributed to the now-anonymised account rather than being deleted --
    // it may still be one somebody else is about to accept.
    administrativeDb.user.update({
      where: { id: userId },
      data: {
        email: placeholder,
        name: 'Erased user',
        passwordHash: null,
        deletedAt: new Date(),
      },
    }),
  ]);
}
