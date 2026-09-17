import { redirect } from 'next/navigation';

import { getCurrentSession } from '@/lib/auth/current-session';

export default async function RootPage(): Promise<never> {
  const session = await getCurrentSession();
  redirect(session === null ? '/login' : '/select-org');
}
