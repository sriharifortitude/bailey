import Link from 'next/link';
import { notFound } from 'next/navigation';

import { AppShell } from '@/components/app-shell';
import { ErrorFromQuery, SuccessFromQuery } from '@/components/alert';
import { SeverityBadge, StatusBadge } from '@/components/badges';
import { requireMembership } from '@/lib/auth/current-session';
import { withOrganisation } from '@/lib/db/tenant';
import { can } from '@/lib/policy/rbac';
import { instructionsFor } from '@/lib/sites/verification';
import {
  checkVerificationAction,
  deleteSiteAction,
  triggerScanAction,
  updateFrequencyAction,
} from './actions';

export const metadata = { title: 'Site · Bailey' };

export default async function SiteDetailPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly orgSlug: string; readonly siteId: string }>;
  readonly searchParams: Promise<{
    readonly error?: string | undefined;
    readonly success?: string | undefined;
  }>;
}): Promise<React.JSX.Element> {
  const { orgSlug, siteId } = await params;
  const { organisation, role, context } = await requireMembership(orgSlug);
  const { error, success } = await searchParams;

  const site = await withOrganisation(context, (db) =>
    db.site.findFirst({
      where: { id: siteId, deletedAt: null },
      include: {
        scanRuns: { orderBy: { queuedAt: 'desc' }, take: 10 },
        issues: {
          where: { status: { in: ['open', 'regressed', 'accepted'] } },
          orderBy: [{ severity: 'asc' }, { firstSeenAt: 'asc' }],
        },
      },
    }),
  );
  if (site === null) notFound();

  const instructions =
    site.verifiedAt === null
      ? instructionsFor(site.origin, site.verificationMethod, site.verificationToken)
      : null;
  const hasActiveScan = site.scanRuns.some((run) => run.status === 'queued' || run.status === 'running');

  return (
    <AppShell orgSlug={organisation.slug} orgName={organisation.name} role={role} active="dashboard">
      <p>
        <Link href={`/o/${orgSlug}`}>&larr; All sites</Link>
      </p>

      <div className="card-title-row">
        <div>
          <h1>{site.label}</h1>
          <p className="subtitle">{site.origin}</p>
        </div>
      </div>

      <ErrorFromQuery error={error} />
      <SuccessFromQuery success={success} />

      {instructions !== null && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Verify ownership</h2>
          <p>Bailey will not scan this site until you prove you control the domain.</p>
          {instructions.method === 'dns_txt' ? (
            <dl className="meta-list">
              <dt>Record type</dt>
              <dd>TXT</dd>
              <dt>Host</dt>
              <dd>
                <code>{instructions.where}</code>
              </dd>
              <dt>Value</dt>
              <dd>
                <code>{instructions.value}</code>
              </dd>
            </dl>
          ) : (
            <dl className="meta-list">
              <dt>File URL</dt>
              <dd>
                <code>{instructions.where}</code>
              </dd>
              <dt>File contents</dt>
              <dd>
                <code>{instructions.value}</code>
              </dd>
            </dl>
          )}
          <p className="subtitle">{instructions.note}</p>

          {can(role, 'site:verify') && (
            <form action={checkVerificationAction}>
              <input type="hidden" name="orgSlug" value={orgSlug} />
              <input type="hidden" name="siteId" value={siteId} />
              <button type="submit">Check now</button>
            </form>
          )}
        </div>
      )}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Scanning</h2>
        <dl className="meta-list">
          <dt>Ownership</dt>
          <dd>{site.verifiedAt === null ? 'Not verified' : `Verified ${new Date(site.verifiedAt).toLocaleDateString()}`}</dd>
          <dt>Schedule</dt>
          <dd>{site.scanFrequency}</dd>
          <dt>Next scan</dt>
          <dd>{site.nextScanAt === null ? 'Not scheduled' : new Date(site.nextScanAt).toLocaleString()}</dd>
        </dl>

        <div className="actions-row">
          {can(role, 'scan:trigger') && (
            <form action={triggerScanAction}>
              <input type="hidden" name="orgSlug" value={orgSlug} />
              <input type="hidden" name="siteId" value={siteId} />
              <button type="submit" disabled={site.verifiedAt === null || hasActiveScan}>
                {hasActiveScan ? 'Scan in progress…' : 'Scan now'}
              </button>
            </form>
          )}

          {can(role, 'site:update') && (
            <form action={updateFrequencyAction} className="actions-row" style={{ margin: 0 }}>
              <input type="hidden" name="orgSlug" value={orgSlug} />
              <input type="hidden" name="siteId" value={siteId} />
              <label htmlFor="frequency" className="hint" style={{ alignSelf: 'center' }}>
                Auto-scan
              </label>
              <select id="frequency" name="frequency" defaultValue={site.scanFrequency}>
                <option value="manual">Manual only</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
              <button type="submit" className="btn-secondary btn-sm">
                Save
              </button>
            </form>
          )}
        </div>

        {site.scanRuns.length > 0 && (
          <>
            <h3>Recent scans</h3>
            <table>
              <thead>
                <tr>
                  <th scope="col">Queued</th>
                  <th scope="col">Status</th>
                  <th scope="col">Requests</th>
                  <th scope="col">Findings</th>
                </tr>
              </thead>
              <tbody>
                {site.scanRuns.map((run) => (
                  <tr key={run.id}>
                    <td>{new Date(run.queuedAt).toLocaleString()}</td>
                    <td>{run.status === 'failed' ? `Failed — ${run.failureReason ?? 'unknown reason'}` : run.status}</td>
                    <td>{run.requestCount ?? '—'}</td>
                    <td>
                      {run.status === 'succeeded'
                        ? `${run.criticalCount + run.highCount + run.mediumCount + run.lowCount + run.infoCount}`
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      <h2>Open issues</h2>
      {site.issues.length === 0 ? (
        <div className="empty-state">
          <p>No open issues on this site.</p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Severity</th>
              <th scope="col">Issue</th>
              <th scope="col">Status</th>
              <th scope="col">First seen</th>
            </tr>
          </thead>
          <tbody>
            {site.issues.map((issue) => (
              <tr key={issue.id}>
                <td>
                  <SeverityBadge severity={issue.severity} />
                </td>
                <td>
                  <Link href={`/o/${orgSlug}/issues/${issue.id}`}>{issue.title}</Link>
                </td>
                <td>
                  <StatusBadge status={issue.status} />
                </td>
                <td>{new Date(issue.firstSeenAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {can(role, 'site:delete') && (
        <div className="card" style={{ borderColor: 'var(--danger)', marginTop: '2rem' }}>
          <h2 style={{ marginTop: 0, color: 'var(--danger)' }}>Danger zone</h2>
          <p>
            Removing a site stops it being scanned. Its history is kept for the audit trail but the
            site no longer appears in the list.
          </p>
          <form action={deleteSiteAction}>
            <input type="hidden" name="orgSlug" value={orgSlug} />
            <input type="hidden" name="siteId" value={siteId} />
            <button type="submit" className="btn-danger">
              Remove this site
            </button>
          </form>
        </div>
      )}
    </AppShell>
  );
}
