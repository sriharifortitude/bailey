import { ErrorFromQuery } from '@/components/alert';
import { getCurrentSession } from '@/lib/auth/current-session';
import { PASSWORD_MIN_LENGTH } from '@/lib/auth/password';
import { hashToken } from '@/lib/auth/session';
import { administrativeDb } from '@/lib/db/tenant';
import { acceptInvitationAction } from './actions';

export const metadata = { title: 'Join organisation · Bailey' };

export default async function AcceptInvitationPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly token: string }>;
  readonly searchParams: Promise<{ readonly error?: string | undefined }>;
}): Promise<React.JSX.Element> {
  const { token } = await params;
  const { error } = await searchParams;

  const invitation = await administrativeDb.invitation.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { organisation: { select: { name: true, deletedAt: true } } },
  });

  const isLive =
    invitation !== null &&
    invitation.revokedAt === null &&
    invitation.acceptedAt === null &&
    invitation.expiresAt.getTime() > Date.now() &&
    invitation.organisation.deletedAt === null;

  if (!isLive) {
    return (
      <main id="main" className="shell">
        <div style={{ maxWidth: '28rem', margin: '4rem auto' }}>
          <h1>Invitation not available</h1>
          <p>This invitation has expired, been revoked, or was already used.</p>
        </div>
      </main>
    );
  }

  const session = await getCurrentSession();
  const emailMismatch = session !== null && session.user.email !== invitation.email;

  return (
    <main id="main" className="shell">
      <div style={{ maxWidth: '28rem', margin: '4rem auto' }}>
        <h1>Join {invitation.organisation.name}</h1>
        <p className="subtitle">
          You have been invited as <strong>{invitation.role}</strong>, to {invitation.email}.
        </p>

        <ErrorFromQuery error={error} />

        {emailMismatch ? (
          <p>
            You are signed in as {session.user.email}. Sign out to accept this invitation with{' '}
            {invitation.email}.
          </p>
        ) : session !== null ? (
          <form action={acceptInvitationAction}>
            <input type="hidden" name="token" value={token} />
            <button type="submit">Accept and join</button>
          </form>
        ) : (
          <form className="stack" action={acceptInvitationAction} noValidate>
            <input type="hidden" name="token" value={token} />
            <p className="subtitle">Create an account to accept this invitation.</p>
            <div className="field">
              <label htmlFor="name">Your name</label>
              <input id="name" name="name" type="text" autoComplete="name" required />
            </div>
            <div className="field">
              <label htmlFor="password">Choose a password</label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={PASSWORD_MIN_LENGTH}
                required
              />
            </div>
            <button type="submit">Create account and join</button>
          </form>
        )}
      </div>
    </main>
  );
}
