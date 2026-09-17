'use server';

import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';

import { SESSION_COOKIE } from '@/lib/auth/cookies';
import { clearSessionCookie } from '@/lib/auth/current-session';
import { revokeSession } from '@/lib/auth/session';

export async function logoutAction(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token !== undefined) await revokeSession(token);
  await clearSessionCookie();
  redirect('/login');
}
