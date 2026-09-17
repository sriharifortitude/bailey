import Link from 'next/link';

import { AppShell } from '@/components/app-shell';
import { SeverityBadge } from '@/components/badges';
import { requireMembership } from '@/lib/auth/current-session';
import { withOrganisation } from '@/lib/db/tenant';
import { can } from '@/lib/policy/rbac';
import type { Severity } from '@prisma/client';

export const metadata = { title: 'Sites · Bailey' };

const SEVERITY_ORDER: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

export default async function DashboardPage({
  params,
}: {
  readonly params: Promise<{ readonly orgSlug: string }>;
}): Promise<React.JSX.Element> {
  const { orgSlug } = await params;
  const { organisation, role, context } = await requireMembership(orgSlug);

  const sites = await withOrganisation(context, (db) =>
    db.site.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'asc' },
      include: {
        issues: {
          where: { status: { in: ['open', 'regressed'] } },
          select: { severity: true },
        },
        scanRuns: {
          orderBy: { queuedAt: 'desc' },
          take: 1,
          select: { status: true, queuedAt: true, finishedAt: true },
        },
      },
    }),
  );

  return (
    <AppShell orgSlug={organisation.slug} orgName={organisation.name} role={role} active="dashboard">
      <div className="card-title-row">
        <h1>Sites</h1>
        {can(role, 'site:create') && (
          <Link href={`/o/${orgSlug}/sites/new`} className="btn">
            Add a site
          </Link>
        )}
      </div>
      <p className="subtitle">Every site {organisation.name} is monitoring, and its open issues.</p>

      {sites.length === 0 ? (
        <div className="empty-state">
          <p>No sites yet.</p>
          {can(role, 'site:create') && (
            <Link href={`/o/${orgSlug}/sites/new`} className="btn">
              Add your first site
            </Link>
          )}
        </div>
      ) : (
        <table>
          <caption style={{ position: 'absolute', left: '-9999px' }}>
            Monitored sites with their current open issues by severity
          </caption>
          <thead>
            <tr>
              <th scope="col">Site</th>
              <th scope="col">Status</th>
              <th scope="col">Open issues</th>
              <th scope="col">Last scan</th>
            </tr>
          </thead>
          <tbody>
            {sites.map((site) => {
              const counts = new Map<Severity, number>();
              for (const issue of site.issues) {
                counts.set(issue.severity, (counts.get(issue.severity) ?? 0) + 1);
              }
              const lastRun = site.scanRuns[0];

              return (
                <tr key={site.id}>
                  <td>
                    <Link href={`/o/${orgSlug}/sites/${site.id}`}>{site.label}</Link>
                    <div style={{ color: 'var(--fg-muted)', fontSize: '0.85rem' }}>{site.origin}</div>
                  </td>
                  <td>{site.verifiedAt === null ? 'Unverified' : 'Verified'}</td>
                  <td>
                    {site.issues.length === 0 ? (
                      <span style={{ color: 'var(--fg-muted)' }}>None</span>
                    ) : (
                      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                        {SEVERITY_ORDER.filter((severity) => (counts.get(severity) ?? 0) > 0).map(
                          (severity) => (
                            <span key={severity}>
                              <SeverityBadge severity={severity} /> {counts.get(severity)}
                            </span>
                          ),
                        )}
                      </div>
                    )}
                  </td>
                  <td>
                    {lastRun === undefined
                      ? 'Never scanned'
                      : `${lastRun.status}${
                          lastRun.finishedAt !== null
                            ? ` · ${new Date(lastRun.finishedAt).toLocaleString()}`
                            : ''
                        }`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </AppShell>
  );
}
