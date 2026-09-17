import Link from 'next/link';

import { ErrorFromQuery } from '@/components/alert';
import { loginAction } from './actions';

export const metadata = { title: 'Sign in · Bailey' };

export default async function LoginPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly error?: string | undefined }>;
}): Promise<React.JSX.Element> {
  const { error } = await searchParams;

  return (
    <main id="main" className="shell">
      <div style={{ maxWidth: '26rem', margin: '4rem auto' }}>
        <h1>Sign in</h1>
        <p className="subtitle">Bailey — continuous web security posture monitoring.</p>

        <ErrorFromQuery error={error} />

        <form className="stack" action={loginAction} noValidate>
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
              autoComplete="current-password"
              required
            />
          </div>

          <button type="submit">Sign in</button>
        </form>

        <p style={{ marginTop: '1.5rem' }}>
          No account yet? <Link href="/signup">Create one</Link>
        </p>
      </div>
    </main>
  );
}
