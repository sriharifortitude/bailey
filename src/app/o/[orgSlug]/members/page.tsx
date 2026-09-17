import { AppShell } from '@/components/app-shell';
import { ErrorFromQuery, SuccessFromQuery } from '@/components/alert';
import { RoleBadge } from '@/components/badges';
import { requireMembership } from '@/lib/auth/current-session';
import { withOrganisation } from '@/lib/db/tenant';
import { assertCan, can, canGrantRole, canManageMember } from '@/lib/policy/rbac';
import { Role } from '@prisma/client';
import {
  changeMemberRoleAction,
  inviteMemberAction,
  removeMemberAction,
  revokeInvitationAction,
} from './actions';

export const metadata = { title: 'Team · Bailey' };

const GRANTABLE_ROLES: readonly Role[] = [Role.admin, Role.member, Role.viewer];

export default async function MembersPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly orgSlug: string }>;
  readonly searchParams: Promise<{
    readonly error?: string | undefined;
    readonly success?: string | undefined;
  }>;
}): Promise<React.JSX.Element> {
  const { orgSlug } = await params;
  const { organisation, role, context, user } = await requireMembership(orgSlug);
  assertCan(role, 'member:read');
  const { error, success } = await searchParams;

  const [members, invitations] = await withOrganisation(context, async (db) => [
    await db.membership.findMany({
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    await db.invitation.findMany({
      where: { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  return (
    <AppShell orgSlug={organisation.slug} orgName={organisation.name} role={role} active="members">
      <h1>Team</h1>
      <p className="subtitle">Who has access to {organisation.name} in Bailey.</p>

      <ErrorFromQuery error={error} />
      <SuccessFromQuery success={success} />

      <table>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Email</th>
            <th scope="col">Role</th>
            <th scope="col">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {members.map((membership) => {
            const isSelf = membership.userId === user.id;
            const manageable = can(role, 'member:change_role') && canManageMember(role, membership.role);

            return (
              <tr key={membership.id}>
                <td>
                  {membership.user.name}
                  {isSelf ? ' (you)' : ''}
                </td>
                <td>{membership.user.email}</td>
                <td>
                  {manageable ? (
                    <form action={changeMemberRoleAction} style={{ display: 'flex', gap: '0.4rem' }}>
                      <input type="hidden" name="orgSlug" value={orgSlug} />
                      <input type="hidden" name="membershipId" value={membership.id} />
                      <select name="role" defaultValue={membership.role}>
                        {GRANTABLE_ROLES.filter((r) => canGrantRole(role, r) || r === membership.role).map(
                          (r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ),
                        )}
                        {membership.role === Role.owner && <option value={Role.owner}>owner</option>}
                      </select>
                      <button type="submit" className="btn-secondary btn-sm">
                        Save
                      </button>
                    </form>
                  ) : (
                    <RoleBadge role={membership.role} />
                  )}
                </td>
                <td>
                  {can(role, 'member:remove') && !isSelf && canManageMember(role, membership.role) && (
                    <form action={removeMemberAction}>
                      <input type="hidden" name="orgSlug" value={orgSlug} />
                      <input type="hidden" name="membershipId" value={membership.id} />
                      <button type="submit" className="btn-danger btn-sm">
                        Remove
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {invitations.length > 0 && (
        <>
          <h2>Pending invitations</h2>
          <table>
            <thead>
              <tr>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
                <th scope="col">Expires</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {invitations.map((invitation) => (
                <tr key={invitation.id}>
                  <td>{invitation.email}</td>
                  <td>
                    <RoleBadge role={invitation.role} />
                  </td>
                  <td>{new Date(invitation.expiresAt).toLocaleDateString()}</td>
                  <td>
                    {can(role, 'member:invite') && (
                      <form action={revokeInvitationAction}>
                        <input type="hidden" name="orgSlug" value={orgSlug} />
                        <input type="hidden" name="invitationId" value={invitation.id} />
                        <button type="submit" className="btn-secondary btn-sm">
                          Revoke
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {can(role, 'member:invite') && (
        <div className="card" style={{ marginTop: '2rem' }}>
          <h2 style={{ marginTop: 0 }}>Invite someone</h2>
          <form action={inviteMemberAction} className="stack">
            <input type="hidden" name="orgSlug" value={orgSlug} />
            <div className="field">
              <label htmlFor="email">Email</label>
              <input id="email" name="email" type="email" required />
            </div>
            <div className="field">
              <label htmlFor="role">Role</label>
              <select id="role" name="role" defaultValue={Role.member}>
                {GRANTABLE_ROLES.filter((r) => canGrantRole(role, r)).map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className="btn-sm" style={{ alignSelf: 'flex-start' }}>
              Send invitation
            </button>
          </form>
        </div>
      )}
    </AppShell>
  );
}
