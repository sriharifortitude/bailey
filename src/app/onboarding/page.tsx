import { ErrorFromQuery } from '@/components/alert';
import { requireSession } from '@/lib/auth/current-session';
import { createOrganisationAction } from './actions';

export const metadata = { title: 'Create an organisation · Bailey' };

export default async function OnboardingPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly error?: string | undefined }>;
}): Promise<React.JSX.Element> {
  await requireSession();
  const { error } = await searchParams;

  return (
    <main id="main" className="shell">
      <div style={{ maxWidth: '28rem', margin: '3.5rem auto' }}>
        <h1>Create an organisation</h1>
        <p className="subtitle">You will be its owner and can invite others once it exists.</p>

        <ErrorFromQuery error={error} />

        <form className="stack" action={createOrganisationAction} noValidate>
          <div className="field">
            <label htmlFor="name">Organisation or team name</label>
            <input id="name" name="name" type="text" autoComplete="organization" required />
          </div>
          <button type="submit">Create</button>
        </form>
      </div>
    </main>
  );
}
