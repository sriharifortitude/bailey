import { AppShell } from '@/components/app-shell';
import { ErrorFromQuery } from '@/components/alert';
import { requireMembership } from '@/lib/auth/current-session';
import { assertCan } from '@/lib/policy/rbac';
import { addSiteAction } from './actions';

export const metadata = { title: 'Add a site · Bailey' };

export default async function AddSitePage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly orgSlug: string }>;
  readonly searchParams: Promise<{ readonly error?: string | undefined }>;
}): Promise<React.JSX.Element> {
  const { orgSlug } = await params;
  const { organisation, role } = await requireMembership(orgSlug);
  assertCan(role, 'site:create');
  const { error } = await searchParams;

  return (
    <AppShell orgSlug={organisation.slug} orgName={organisation.name} role={role} active="dashboard">
      <h1>Add a site</h1>
      <p className="subtitle">
        You will need to prove control of the domain before Bailey will scan it.
      </p>

      <ErrorFromQuery error={error} />

      <form className="stack" action={addSiteAction} noValidate>
        <input type="hidden" name="orgSlug" value={orgSlug} />

        <div className="field">
          <label htmlFor="label">Name</label>
          <input id="label" name="label" type="text" placeholder="Client's marketing site" required />
        </div>

        <div className="field">
          <label htmlFor="origin">Website address</label>
          <input id="origin" name="origin" type="text" placeholder="example.com" required />
        </div>

        <fieldset className="field" style={{ border: 'none', padding: 0 }}>
          <legend style={{ fontWeight: 600, fontSize: '0.9rem', padding: 0 }}>
            How will you prove ownership?
          </legend>
          <div style={{ display: 'flex', gap: '1.5rem', marginTop: '0.4rem' }}>
            <label style={{ fontWeight: 400, display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
              <input type="radio" name="method" value="dns_txt" defaultChecked /> DNS TXT record
            </label>
            <label style={{ fontWeight: 400, display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
              <input type="radio" name="method" value="well_known_file" /> Uploaded file
            </label>
          </div>
        </fieldset>

        <button type="submit">Add site</button>
      </form>
    </AppShell>
  );
}
