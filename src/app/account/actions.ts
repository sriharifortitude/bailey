'use server';

import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';

import { SESSION_COOKIE } from '@/lib/auth/cookies';
import { clearSessionCookie, requireSession } from '@/lib/auth/current-session';
import { describePasswordProblem, hashPassword, verifyPassword } from '@/lib/auth/password';
import { revokeAllSessionsForUser, revokeSession } from '@/lib/auth/session';
import { withoutTenantScope } from '@/lib/db/tenant';
import { ErasureBlockedError, eraseUserPersonalData } from '@/lib/gdpr/erasure';
import { formString } from '@/lib/forms';

function back(message: string): never {
  redirect(`/account?error=${encodeURIComponent(message)}`);
}

export async function changePasswordAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const currentPassword = formString(formData, 'currentPassword');
  const newPassword = formString(formData, 'newPassword');

  const user = await withoutTenantScope((db) =>
    db.user.findUniqueOrThrow({ where: { id: session.user.id } }),
  );
  const currentOk = await verifyPassword(user.passwordHash, currentPassword);
  if (!currentOk) back('Current password is incorrect.');

  const problem = describePasswordProblem(newPassword);
  if (problem !== undefined) back(problem);

  const passwordHash = await hashPassword(newPassword);
  await withoutTenantScope((db) =>
    db.user.update({ where: { id: session.user.id }, data: { passwordHash } }),
  );

  // Every other session is revoked: a token an attacker fixed or captured
  // before the change stops working. The one making this request stays
  // signed in, which is why the current token is excluded rather than
  // rotated -- rotating it here would sign the user themselves out of the
  // page they are looking at.
  const store = await cookies();
  const currentToken = store.get(SESSION_COOKIE)?.value;
  await revokeAllSessionsForUser(
    session.user.id,
    currentToken === undefined ? {} : { exceptToken: currentToken },
  );

  redirect(`/account?success=${encodeURIComponent('Password changed. Other devices were signed out.')}`);
}

export async function revokeOtherSessionAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const tokenHash = formString(formData, 'tokenHash');

  // Deleted by hash directly rather than through revokeSession(), which takes
  // a raw token: the raw token of a *different* session was never available
  // to this page to begin with, by design -- only its hash was ever stored.
  await withoutTenantScope((db) =>
    db.session.deleteMany({ where: { tokenHash, userId: session.user.id } }),
  );

  redirect(`/account?success=${encodeURIComponent('Session signed out.')}`);
}

export async function requestErasureAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const confirmation = formString(formData, 'confirmation');
  if (confirmation !== 'DELETE') back('Type DELETE to confirm.');

  try {
    await eraseUserPersonalData(session.user.id);
  } catch (error) {
    if (error instanceof ErasureBlockedError) back(error.message);
    throw error;
  }

  const store = await cookies();
  const currentToken = store.get(SESSION_COOKIE)?.value;
  if (currentToken !== undefined) await revokeSession(currentToken);
  await clearSessionCookie();

  redirect('/login');
}
