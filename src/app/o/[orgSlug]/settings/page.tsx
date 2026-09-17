import { AppShell } from '@/components/app-shell';
import { ErrorFromQuery, SuccessFromQuery } from '@/components/alert';
import { requireMembership } from '@/lib/auth/current-session';
import { withOrganisation } from '@/lib/db/tenant';
import { can } from '@/lib/policy/rbac';
import { deleteOrganisationAction, updateOrganisationAction } from './actions';

export const metadata = { title: 'Settings · Bailey' };

export default async function SettingsPage({
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
  const { organisation, role, context } = await requireMembership(orgSlug);
  const { error, success } = await searchParams;

  const current = await withOrganisation(context, (db) =>
    db.organisation.findUniqueOrThrow({
      where: { id: context.organisationId },
      select: { name: true, scanRetentionDays: true },
    }),
  );

  return (
    <AppShell orgSlug={organisation.slug} orgName={organisation.name} role={role} active="settings">
      <h1>Settings</h1>

      <ErrorFromQuery error={error} />
      <SuccessFromQuery success={success} />

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Organisation</h2>
        {can(role, 'organisation:update') ? (
          <form action={updateOrganisationAction} className="stack">
            <input type="hidden" name="orgSlug" value={orgSlug} />
            <div className="field">
              <label htmlFor="name">Name</label>
              <input id="name" name="name" type="text" defaultValue={current.name} required />
            </div>
            <div className="field">
              <label htmlFor="retentionDays">Scan data retention (days)</label>
              <input
                id="retentionDays"
                name="retentionDays"
                type="text"
                inputMode="numeric"
                defaultValue={current.scanRetentionDays}
              />
              <span className="hint">
                Scan runs and findings older than this are deleted automatically. Between 30 and 3650
                days.
              </span>
            </div>
            <button type="submit" style={{ alignSelf: 'flex-start' }}>
              Save
            </button>
          </form>
        ) : (
          <dl className="meta-list">
            <dt>Name</dt>
            <dd>{current.name}</dd>
            <dt>Retention</dt>
            <dd>{current.scanRetentionDays} days</dd>
          </dl>
        )}
      </div>

      {can(role, 'organisation:delete') && (
        <div className="card" style={{ borderColor: 'var(--danger)' }}>
          <h2 style={{ marginTop: 0, color: 'var(--danger)' }}>Danger zone</h2>
          <p>
            Deleting {organisation.name} removes every member&apos;s access. Sites stop being scanned.
            This cannot be undone from the app.
          </p>
          <form action={deleteOrganisationAction} className="stack">
            <input type="hidden" name="orgSlug" value={orgSlug} />
            <div className="field">
              <label htmlFor="confirmation">
                Type <strong>{organisation.name}</strong> to confirm
              </label>
              <input id="confirmation" name="confirmation" type="text" required />
            </div>
            <button type="submit" className="btn-danger" style={{ alignSelf: 'flex-start' }}>
              Delete organisation
            </button>
          </form>
        </div>
      )}
    </AppShell>
  );
}
