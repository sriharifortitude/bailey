import Link from 'next/link';
import { redirect } from 'next/navigation';

import { requireSession } from '@/lib/auth/current-session';
import { administrativeDb, withUser } from '@/lib/db/tenant';
import { RoleBadge } from '@/components/badges';

export const metadata = { title: 'Select an organisation · Bailey' };

/**
 * Reached after login when a person belongs to more than one organisation --
 * an agency's own staff, most often, working across several clients' orgs.
 */
export default async function SelectOrgPage(): Promise<React.JSX.Element> {
  const session = await requireSession();

  const memberships = await withUser(session.user.id, (db) =>
    db.membership.findMany({
      where: { userId: session.user.id },
      select: { organisationId: true, role: true },
    }),
  );

  const organisations = await administrativeDb.organisation.findMany({
    where: { id: { in: memberships.map((membership) => membership.organisationId) }, deletedAt: null },
    select: { id: true, name: true, slug: true },
    orderBy: { name: 'asc' },
  });

  const roleByOrgId = new Map(memberships.map((membership) => [membership.organisationId, membership.role]));

  // Reached directly (e.g. a bookmarked "/") as well as after login, so the
  // single-organisation shortcut belongs here too, not only in the login action.
  if (organisations.length === 1) redirect(`/o/${organisations[0]!.slug}`);

  return (
    <main id="main" className="shell">
      <div style={{ maxWidth: '32rem', margin: '3.5rem auto' }}>
        <h1>Select an organisation</h1>
        <p className="subtitle">Signed in as {session.user.email}.</p>

        {organisations.length === 0 ? (
          <div className="empty-state">
            <p>You are not a member of any organisation.</p>
            <Link href="/onboarding" className="btn">
              Create one
            </Link>
          </div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {organisations.map((organisation) => (
              <li key={organisation.id} className="card">
                <div className="card-title-row">
                  <Link href={`/o/${organisation.slug}`}>{organisation.name}</Link>
                  <RoleBadge role={roleByOrgId.get(organisation.id) ?? 'viewer'} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
