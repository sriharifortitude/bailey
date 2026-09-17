import { cookies } from 'next/headers';

import { ErrorFromQuery, SuccessFromQuery } from '@/components/alert';
import { SESSION_COOKIE } from '@/lib/auth/cookies';
import { requireSession } from '@/lib/auth/current-session';
import { PASSWORD_MIN_LENGTH } from '@/lib/auth/password';
import { hashToken } from '@/lib/auth/session';
import { withoutTenantScope } from '@/lib/db/tenant';
import { changePasswordAction, requestErasureAction, revokeOtherSessionAction } from './actions';

export const metadata = { title: 'Account · Bailey' };

export default async function AccountPage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly error?: string | undefined;
    readonly success?: string | undefined;
  }>;
}): Promise<React.JSX.Element> {
  const session = await requireSession();
  const { error, success } = await searchParams;

  const store = await cookies();
  const currentTokenHash = hashToken(store.get(SESSION_COOKIE)?.value ?? '');

  const sessions = await withoutTenantScope((db) =>
    db.session.findMany({
      where: { userId: session.user.id },
      orderBy: { lastSeenAt: 'desc' },
    }),
  );

  return (
    <>
      <header className="topbar">
        <div className="shell topbar-inner">
          <a href="/select-org" className="topbar-brand">
            Bailey
          </a>
          <nav className="topbar-nav" aria-label="Primary">
            <a href="/select-org">Organisations</a>
            <a href="/account" aria-current="page">
              Account
            </a>
          </nav>
        </div>
      </header>

      <main id="main" className="shell">
        <h1>Account</h1>
        <p className="subtitle">
          {session.user.name} &middot; {session.user.email}
        </p>

        <ErrorFromQuery error={error} />
        <SuccessFromQuery success={success} />

        <div className="card">
          <h2 style={{ marginTop: 0 }}>Change password</h2>
          <form action={changePasswordAction} className="stack">
            <div className="field">
              <label htmlFor="currentPassword">Current password</label>
              <input
                id="currentPassword"
                name="currentPassword"
                type="password"
                autoComplete="current-password"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="newPassword">New password</label>
              <input
                id="newPassword"
                name="newPassword"
                type="password"
                autoComplete="new-password"
                minLength={PASSWORD_MIN_LENGTH}
                required
              />
            </div>
            <button type="submit" style={{ alignSelf: 'flex-start' }}>
              Change password
            </button>
          </form>
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0 }}>Active sessions</h2>
          <table>
            <thead>
              <tr>
                <th scope="col">Device</th>
                <th scope="col">Last active</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => {
                const isCurrent = s.tokenHash === currentTokenHash;
                return (
                  <tr key={s.id}>
                    <td>
                      {s.userAgent ?? 'Unknown device'}
                      {isCurrent ? ' (this device)' : ''}
                      {s.ipPrefix !== null && (
                        <div style={{ color: 'var(--fg-muted)', fontSize: '0.82rem' }}>{s.ipPrefix}</div>
                      )}
                    </td>
                    <td>{new Date(s.lastSeenAt).toLocaleString()}</td>
                    <td>
                      {!isCurrent && (
                        <form action={revokeOtherSessionAction}>
                          <input type="hidden" name="tokenHash" value={s.tokenHash} />
                          <button type="submit" className="btn-secondary btn-sm">
                            Sign out
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0 }}>Your data</h2>
          <p>
            Download everything Bailey holds about you: your profile, session history, organisation
            memberships and issues assigned to you.
          </p>
          <a href="/account/export" className="btn btn-secondary">
            Download my data
          </a>
        </div>

        <div className="card" style={{ borderColor: 'var(--danger)' }}>
          <h2 style={{ marginTop: 0, color: 'var(--danger)' }}>Delete account</h2>
          <p>
            Your name, email and password are erased and every session is signed out. This cannot be
            done while you are the sole owner of an organisation — transfer ownership or delete that
            organisation first.
          </p>
          <form action={requestErasureAction} className="stack">
            <div className="field">
              <label htmlFor="confirmation">
                Type <strong>DELETE</strong> to confirm
              </label>
              <input id="confirmation" name="confirmation" type="text" required />
            </div>
            <button type="submit" className="btn-danger" style={{ alignSelf: 'flex-start' }}>
              Delete my account
            </button>
          </form>
        </div>
      </main>
    </>
  );
}
