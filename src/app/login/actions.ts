'use server';

import { redirect } from 'next/navigation';

import { setSessionCookie } from '@/lib/auth/current-session';
import { hashPassword, needsRehash, verifyPassword } from '@/lib/auth/password';
import { createSession } from '@/lib/auth/session';
import { administrativeDb, withUser, withoutTenantScope } from '@/lib/db/tenant';
import { formString } from '@/lib/forms';

function back(message: string): never {
  redirect(`/login?error=${encodeURIComponent(message)}`);
}

export async function loginAction(formData: FormData): Promise<void> {
  const email = formString(formData, 'email').trim().toLowerCase();
  const password = formString(formData, 'password');

  if (email === '' || password === '') back('Enter your email and password.');

  const user = await withoutTenantScope((db) => db.user.findUnique({ where: { email } }));

  // verifyPassword is called on the not-found path too, with a null hash, so
  // it still does the argon2 work. Skipping it there would make response
  // time the tell for whether an address has an account -- a user
  // enumeration primitive, not just a login bug.
  const passwordOk = await verifyPassword(user?.passwordHash, password);

  if (user === null || user.deletedAt !== null || !passwordOk) {
    back('Incorrect email or password.');
  }

  if (needsRehash(user.passwordHash ?? '')) {
    const upgraded = await hashPassword(password);
    await withoutTenantScope((db) =>
      db.user.update({ where: { id: user.id }, data: { passwordHash: upgraded } }),
    );
  }

  const { token, session } = await createSession(user.id);
  await setSessionCookie(token, session.expiresAt);

  // Two steps rather than a join, because membership and organisation each
  // carry their own row-level security policy and organisationId is not yet
  // selected: a join across them here would be filtered by the organisation
  // policy before that context exists. withUser() is scoped correctly for
  // "my memberships"; the slug lookup that follows is the same narrow,
  // considered exception used in requireMembership() -- a slug and a
  // deletion flag are not tenant secrets.
  const memberships = await withUser(user.id, (db) =>
    db.membership.findMany({ where: { userId: user.id }, select: { organisationId: true } }),
  );
  const organisations = await administrativeDb.organisation.findMany({
    where: { id: { in: memberships.map((membership) => membership.organisationId) }, deletedAt: null },
    select: { slug: true },
  });

  if (organisations.length === 0) redirect('/onboarding');
  if (organisations.length === 1) redirect(`/o/${organisations[0]!.slug}`);
  redirect('/select-org');
}
