import Link from 'next/link';

import { ErrorFromQuery } from '@/components/alert';
import { PASSWORD_MIN_LENGTH } from '@/lib/auth/password';
import { signupAction } from './actions';

export const metadata = { title: 'Create an account · Bailey' };

export default async function SignupPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly error?: string | undefined }>;
}): Promise<React.JSX.Element> {
  const { error } = await searchParams;

  return (
    <main id="main" className="shell">
      <div style={{ maxWidth: '28rem', margin: '3.5rem auto' }}>
        <h1>Create an account</h1>
        <p className="subtitle">Start monitoring the sites you manage.</p>

        <ErrorFromQuery error={error} />

        <form className="stack" action={signupAction} noValidate>
          <div className="field">
            <label htmlFor="name">Your name</label>
            <input id="name" name="name" type="text" autoComplete="name" required />
          </div>

          <div className="field">
            <label htmlFor="orgName">Organisation or team name</label>
            <input id="orgName" name="orgName" type="text" autoComplete="organization" required />
            <span className="hint">You can invite colleagues to this once you are signed in.</span>
          </div>

          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" name="email" type="email" autoComplete="email" required />
          </div>

          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={PASSWORD_MIN_LENGTH}
              required
              aria-describedby="password-hint"
            />
            <span id="password-hint" className="hint">
              At least {PASSWORD_MIN_LENGTH} characters. Longer is better than complex.
            </span>
          </div>

          <button type="submit">Create account</button>
        </form>

        <p style={{ marginTop: '1.5rem' }}>
          Already have an account? <Link href="/login">Sign in</Link>
        </p>
      </div>
    </main>
  );
}
