import { describe, expect, it } from 'vitest';
import { Role } from '@prisma/client';

import {
  PERMISSIONS,
  READ_PERMISSIONS,
  can,
  canGrantRole,
  canManageMember,
  permissionsFor,
  wouldRemoveLastOwner,
  type Permission,
} from '@/lib/policy/rbac';

describe('permission table invariants', () => {
  // These catch the realistic mistake: someone adds a permission and wires it
  // into one role without thinking about the others.
  it('grants every defined permission to owner', () => {
    const ownerPermissions = new Set(permissionsFor(Role.owner));
    const missing = PERMISSIONS.filter((permission) => !ownerPermissions.has(permission));
    expect(missing).toEqual([]);
  });

  it('gives viewer read access and nothing else', () => {
    expect([...permissionsFor(Role.viewer)].sort()).toEqual([...READ_PERMISSIONS].sort());
  });

  it('never lets a lower role hold a permission a higher role lacks', () => {
    const ordered = [Role.viewer, Role.member, Role.admin, Role.owner];

    for (let i = 0; i < ordered.length - 1; i += 1) {
      const lower = new Set(permissionsFor(ordered[i]!));
      const higher = new Set(permissionsFor(ordered[i + 1]!));
      const exclusive = [...lower].filter((permission) => !higher.has(permission));
      expect(exclusive, `${ordered[i]!} has permissions ${ordered[i + 1]!} lacks`).toEqual([]);
    }
  });

  it('assigns every permission to at least one role below owner, except deletion', () => {
    const adminPermissions = new Set(permissionsFor(Role.admin));
    const ownerOnly = PERMISSIONS.filter((permission) => !adminPermissions.has(permission));
    // Deleting the organisation is irreversible and takes every client's
    // history with it, so it is deliberately owner-only.
    expect(ownerOnly).toEqual(['organisation:delete']);
  });
});

describe('can', () => {
  it.each<[Role, Permission, boolean]>([
    [Role.viewer, 'site:read', true],
    [Role.viewer, 'site:create', false],
    [Role.viewer, 'scan:trigger', false],
    [Role.member, 'scan:trigger', true],
    [Role.member, 'site:delete', false],
    [Role.member, 'member:invite', false],
    [Role.admin, 'site:delete', true],
    [Role.admin, 'organisation:delete', false],
    [Role.owner, 'organisation:delete', true],
  ])('%s %s -> %s', (role, permission, expected) => {
    expect(can(role, permission)).toBe(expected);
  });
});

describe('member management', () => {
  it('only allows acting on a strictly more junior member', () => {
    expect(canManageMember(Role.owner, Role.admin)).toBe(true);
    expect(canManageMember(Role.admin, Role.member)).toBe(true);
    expect(canManageMember(Role.admin, Role.admin)).toBe(false);
    expect(canManageMember(Role.admin, Role.owner)).toBe(false);
    expect(canManageMember(Role.member, Role.viewer)).toBe(false);
  });

  // Without this an admin could promote a colleague to owner and have that
  // colleague remove them: privilege escalation by proxy.
  it('does not let a role grant its own rank or higher', () => {
    expect(canGrantRole(Role.admin, Role.owner)).toBe(false);
    expect(canGrantRole(Role.admin, Role.admin)).toBe(false);
    expect(canGrantRole(Role.admin, Role.member)).toBe(true);
    expect(canGrantRole(Role.owner, Role.admin)).toBe(true);
  });
});

describe('wouldRemoveLastOwner', () => {
  const soleOwner = [
    { userId: 'u1', role: Role.owner },
    { userId: 'u2', role: Role.admin },
  ];
  const twoOwners = [
    { userId: 'u1', role: Role.owner },
    { userId: 'u2', role: Role.owner },
  ];

  it('blocks removing the only owner', () => {
    expect(wouldRemoveLastOwner(soleOwner, { userId: 'u1', newRole: null })).toBe(true);
  });

  it('blocks demoting the only owner', () => {
    expect(wouldRemoveLastOwner(soleOwner, { userId: 'u1', newRole: Role.admin })).toBe(true);
  });

  it('allows removing an owner when another remains', () => {
    expect(wouldRemoveLastOwner(twoOwners, { userId: 'u1', newRole: null })).toBe(false);
  });

  it('ignores changes to members who are not owners', () => {
    expect(wouldRemoveLastOwner(soleOwner, { userId: 'u2', newRole: null })).toBe(false);
  });

  it('allows a no-op that keeps the owner an owner', () => {
    expect(wouldRemoveLastOwner(soleOwner, { userId: 'u1', newRole: Role.owner })).toBe(false);
  });
});
