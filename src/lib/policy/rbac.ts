import { Role } from '@prisma/client';

/**
 * Authorisation lives here and nowhere else.
 *
 * The failure mode this module exists to prevent is the common one: role checks
 * written inline in each route handler, where the twentieth handler forgets one
 * and nobody notices until a viewer deletes a site. Handlers ask `can()`; they
 * do not compare roles themselves.
 *
 * Permissions are named resource:verb and are the unit of authorisation. Roles
 * are a mapping onto them, which means adding a capability is a change to one
 * table rather than a search through the codebase.
 */

export const PERMISSIONS = [
  'organisation:read',
  'organisation:update',
  'organisation:delete',

  'member:read',
  'member:invite',
  'member:remove',
  'member:change_role',

  'site:read',
  'site:create',
  'site:update',
  'site:delete',
  'site:verify',

  'scan:read',
  'scan:trigger',

  'issue:read',
  'issue:triage',
  'issue:assign',

  'audit:read',
  'export:create',
  'retention:update',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Permissions that only observe. Used by the invariant tests. */
export const READ_PERMISSIONS: readonly Permission[] = [
  'organisation:read',
  'member:read',
  'site:read',
  'scan:read',
  'issue:read',
];

const VIEWER: readonly Permission[] = READ_PERMISSIONS;

const MEMBER: readonly Permission[] = [
  ...VIEWER,
  'site:create',
  'site:update',
  'site:verify',
  'scan:trigger',
  'issue:triage',
  'issue:assign',
];

const ADMIN: readonly Permission[] = [
  ...MEMBER,
  'organisation:update',
  'member:invite',
  'member:remove',
  'member:change_role',
  'site:delete',
  'audit:read',
  'export:create',
  'retention:update',
];

// Deleting the organisation is the one thing an admin cannot do. It is
// irreversible and takes every client's scan history with it.
const OWNER: readonly Permission[] = [...ADMIN, 'organisation:delete'];

const BY_ROLE: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  [Role.owner]: new Set(OWNER),
  [Role.admin]: new Set(ADMIN),
  [Role.member]: new Set(MEMBER),
  [Role.viewer]: new Set(VIEWER),
};

export function can(role: Role, permission: Permission): boolean {
  return BY_ROLE[role].has(permission);
}

export function permissionsFor(role: Role): readonly Permission[] {
  return [...BY_ROLE[role]];
}

export class ForbiddenError extends Error {
  constructor(readonly permission: Permission) {
    super(`This role is not permitted to ${permission}.`);
    this.name = 'ForbiddenError';
  }
}

export function assertCan(role: Role, permission: Permission): void {
  if (!can(role, permission)) throw new ForbiddenError(permission);
}

/**
 * Seniority, used only for the questions role comparison genuinely answers:
 * who may change whose role, and who may remove whom.
 */
const RANK: Readonly<Record<Role, number>> = {
  [Role.viewer]: 0,
  [Role.member]: 1,
  [Role.admin]: 2,
  [Role.owner]: 3,
};

/**
 * Whether `actor` may administer a member holding `target`.
 *
 * Two conditions, both required. The actor must hold the management permission
 * at all, and must outrank the person being acted on.
 *
 * The permission half is not redundant with the caller's own `assertCan`.
 * Rank alone would answer "yes" for a member acting on a viewer, even though
 * no member can manage anybody -- and a caller that checked only this function
 * would then be wrong. A predicate that is safe on its own is worth more than
 * one that relies on being called in the right order.
 */
export function canManageMember(actor: Role, target: Role): boolean {
  return can(actor, 'member:remove') && RANK[actor] > RANK[target];
}

/**
 * Whether `actor` may grant `roleToGrant`.
 *
 * Granting a role at or above your own is forbidden: without that, an admin
 * could promote a colleague to owner and be removed by them. Privilege
 * escalation by proxy is a recurring finding in team-management code.
 */
export function canGrantRole(actor: Role, roleToGrant: Role): boolean {
  return can(actor, 'member:change_role') && RANK[actor] > RANK[roleToGrant];
}

/**
 * An organisation must always have at least one owner. Callers check this
 * before removing a member or demoting one, so a team cannot lock itself out.
 */
export function wouldRemoveLastOwner(
  memberships: ReadonlyArray<{ readonly userId: string; readonly role: Role }>,
  change: { readonly userId: string; readonly newRole: Role | null },
): boolean {
  const owners = memberships.filter((membership) => membership.role === Role.owner);
  const affectsAnOwner = owners.some((owner) => owner.userId === change.userId);
  if (!affectsAnOwner) return false;

  const remaining = change.newRole === Role.owner ? owners.length : owners.length - 1;
  return remaining < 1;
}
