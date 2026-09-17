import Link from 'next/link';
import { notFound } from 'next/navigation';

import { AppShell } from '@/components/app-shell';
import { ErrorFromQuery, SuccessFromQuery } from '@/components/alert';
import { SeverityBadge, StatusBadge } from '@/components/badges';
import { requireMembership } from '@/lib/auth/current-session';
import { withOrganisation } from '@/lib/db/tenant';
import { can } from '@/lib/policy/rbac';
import { acceptIssueAction, assignIssueAction, reopenIssueAction } from './actions';

export const metadata = { title: 'Issue · Bailey' };

function describeEvidence(item: unknown): string {
  if (item === null || typeof item !== 'object') return String(item);
  const evidence = item as Record<string, unknown>;
  switch (evidence['kind']) {
    case 'header':
      return `${String(evidence['name'])}: ${String(evidence['value'])}`;
    case 'missing-header':
      return `${String(evidence['name'])}: (absent)`;
    case 'exchange':
      return `${String(evidence['method'])} ${String(evidence['url'])} -> ${String(evidence['status'])}`;
    case 'body':
      return `${String(evidence['url'])}\n${String(evidence['excerpt'])}`;
    case 'markup':
      return String(evidence['snippet']);
    case 'certificate':
      return Object.entries((evidence['detail'] as Record<string, string>) ?? {})
        .map(([key, value]) => `${key}: ${value}`)
        .join('\n');
    case 'note':
      return String(evidence['text']);
    default:
      return JSON.stringify(evidence);
  }
}

export default async function IssueDetailPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly orgSlug: string; readonly issueId: string }>;
  readonly searchParams: Promise<{
    readonly error?: string | undefined;
    readonly success?: string | undefined;
  }>;
}): Promise<React.JSX.Element> {
  const { orgSlug, issueId } = await params;
  const { organisation, role, context } = await requireMembership(orgSlug);
  const { error, success } = await searchParams;

  const issue = await withOrganisation(context, (db) =>
    db.issue.findUnique({
      where: { id: issueId },
      include: {
        site: { select: { id: true, label: true, origin: true } },
        assignedTo: { select: { id: true, name: true, email: true } },
        events: { orderBy: { createdAt: 'desc' }, take: 30, include: { actor: { select: { name: true } } } },
        findings: { orderBy: { scanRun: { queuedAt: 'desc' } }, take: 1 },
      },
    }),
  );
  if (issue === null) notFound();

  const latestFinding = issue.findings[0];

  const members = can(role, 'issue:assign')
    ? await withOrganisation(context, (db) =>
        db.membership.findMany({
          where: {},
          include: { user: { select: { id: true, name: true, email: true } } },
          orderBy: { createdAt: 'asc' },
        }),
      )
    : [];

  return (
    <AppShell orgSlug={organisation.slug} orgName={organisation.name} role={role} active="dashboard">
      <p>
        <Link href={`/o/${orgSlug}/sites/${issue.site.id}`}>&larr; {issue.site.label}</Link>
      </p>

      <div className="card-title-row">
        <h1>{issue.title}</h1>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <SeverityBadge severity={issue.severity} />
          <StatusBadge status={issue.status} />
        </div>
      </div>
      <p className="subtitle">
        {issue.category} · <code>{issue.findingKey}</code>
      </p>

      <ErrorFromQuery error={error} />
      <SuccessFromQuery success={success} />

      {latestFinding !== undefined && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>What was found</h2>
          <p>{latestFinding.summary}</p>
          <h3>Remediation</h3>
          <p>{latestFinding.remediation}</p>
          {Array.isArray(latestFinding.evidence) && latestFinding.evidence.length > 0 && (
            <>
              <h3>Evidence</h3>
              {/* React escapes text content automatically, so evidence drawn
                  from the scanned site -- which is attacker-controlled by
                  definition -- cannot inject markup here. */}
              <pre>{latestFinding.evidence.map(describeEvidence).join('\n')}</pre>
            </>
          )}
        </div>
      )}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Triage</h2>

        <dl className="meta-list">
          <dt>First seen</dt>
          <dd>{new Date(issue.firstSeenAt).toLocaleDateString()}</dd>
          <dt>Last seen</dt>
          <dd>{new Date(issue.lastSeenAt).toLocaleDateString()}</dd>
          <dt>Assigned to</dt>
          <dd>{issue.assignedTo === null ? 'Unassigned' : issue.assignedTo.name}</dd>
          {issue.status === 'accepted' && (
            <>
              <dt>Accepted because</dt>
              <dd>{issue.acceptedReason}</dd>
              <dt>Accepted until</dt>
              <dd>
                {issue.acceptedUntil === null
                  ? 'Indefinitely'
                  : new Date(issue.acceptedUntil).toLocaleDateString()}
              </dd>
            </>
          )}
        </dl>

        <div className="actions-row">
          {can(role, 'issue:triage') && issue.status !== 'accepted' && issue.status !== 'resolved' && (
            <details>
              <summary>
                <span className="btn btn-secondary btn-sm" role="button">
                  Accept this risk
                </span>
              </summary>
              <form action={acceptIssueAction} className="stack" style={{ marginTop: '0.8rem' }}>
                <input type="hidden" name="orgSlug" value={orgSlug} />
                <input type="hidden" name="issueId" value={issueId} />
                <div className="field">
                  <label htmlFor="reason">Reason</label>
                  <textarea id="reason" name="reason" rows={2} required />
                </div>
                <div className="field">
                  <label htmlFor="until">Accepted until (optional)</label>
                  <input id="until" name="until" type="date" />
                  <span className="hint">Leave blank to accept indefinitely.</span>
                </div>
                <button type="submit" className="btn-sm" style={{ alignSelf: 'flex-start' }}>
                  Confirm
                </button>
              </form>
            </details>
          )}

          {can(role, 'issue:triage') && issue.status === 'accepted' && (
            <form action={reopenIssueAction}>
              <input type="hidden" name="orgSlug" value={orgSlug} />
              <input type="hidden" name="issueId" value={issueId} />
              <button type="submit" className="btn-secondary btn-sm">
                Reopen
              </button>
            </form>
          )}
        </div>

        {can(role, 'issue:assign') && (
          <form action={assignIssueAction} className="actions-row" style={{ margin: '0.5rem 0 0' }}>
            <input type="hidden" name="orgSlug" value={orgSlug} />
            <input type="hidden" name="issueId" value={issueId} />
            <label htmlFor="assigneeId" className="hint" style={{ alignSelf: 'center' }}>
              Assign to
            </label>
            <select id="assigneeId" name="assigneeId" defaultValue={issue.assignedToUserId ?? ''}>
              <option value="">Unassigned</option>
              {members.map((membership) => (
                <option key={membership.userId} value={membership.userId}>
                  {membership.user.name}
                </option>
              ))}
            </select>
            <button type="submit" className="btn-secondary btn-sm">
              Save
            </button>
          </form>
        )}
      </div>

      <h2>History</h2>
      {issue.events.length === 0 ? (
        <p className="subtitle">No events recorded yet.</p>
      ) : (
        <ol className="timeline">
          {issue.events.map((event) => (
            <li key={event.id}>
              <time dateTime={event.createdAt.toISOString()}>
                {new Date(event.createdAt).toLocaleString()}
              </time>
              {describeEvent(event.type)}
              {event.note !== null && ` — ${event.note}`}
              {event.actor !== null && ` (${event.actor.name})`}
            </li>
          ))}
        </ol>
      )}
    </AppShell>
  );
}

function describeEvent(type: string): string {
  switch (type) {
    case 'opened':
      return 'Opened';
    case 'reobserved':
      return 'Seen again';
    case 'regressed':
      return 'Regressed — this had been resolved';
    case 'auto_resolved':
      return 'Resolved automatically — no longer detected';
    case 'severity_changed':
      return 'Severity changed';
    case 'acceptance_expired':
      return 'Accepted risk period ended; reopened';
    case 'accepted':
      return 'Risk accepted';
    case 'reopened':
      return 'Reopened';
    default:
      return type;
  }
}
