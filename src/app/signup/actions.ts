'use server';

import { redirect } from 'next/navigation';
import { Role } from '@prisma/client';

import { setSessionCookie } from '@/lib/auth/current-session';
import { describePasswordProblem, hashPassword } from '@/lib/auth/password';
import { createSession } from '@/lib/auth/session';
import { withoutTenantScope, administrativeDb } from '@/lib/db/tenant';
import { generateUniqueSlug } from '@/lib/org/slug';
import { formString } from '@/lib/forms';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function back(message: string): never {
  redirect(`/signup?error=${encodeURIComponent(message)}`);
}

export async function signupAction(formData: FormData): Promise<void> {
  const name = formString(formData, 'name').trim();
  const orgName = formString(formData, 'orgName').trim();
  const email = formString(formData, 'email').trim().toLowerCase();
  const password = formString(formData, 'password');

  if (name === '') back('Enter your name.');
  if (orgName === '') back('Enter a name for your organisation or team.');
  if (!EMAIL_RE.test(email)) back('Enter a valid email address.');

  const passwordProblem = describePasswordProblem(password);
  if (passwordProblem !== undefined) back(passwordProblem);

  const existing = await withoutTenantScope((db) => db.user.findUnique({ where: { email } }));
  if (existing !== null) {
    // Disclosing this at signup, unlike at login, does not weaken anything:
    // the visitor already knows they are trying this exact address on
    // purpose, and the alternative -- a generic "check your email" response
    // with no email sent -- is worse UX for a product with no email delivery
    // step in the signup flow yet.
    back('An account with this email already exists. Try signing in instead.');
  }

  const passwordHash = await hashPassword(password);
  const slug = await generateUniqueSlug(orgName);

  const user = await withoutTenantScope((db) =>
    db.user.create({ data: { email, name, passwordHash } }),
  );

  // Organisation creation runs through the owner connection because the
  // organisation does not exist yet for a tenant context to be scoped to --
  // there is nothing for row-level security to check membership against
  // until this row and the owning membership exist. Every read of this
  // organisation from this point on goes through withOrganisation().
  const organisation = await administrativeDb.organisation.create({
    data: {
      name: orgName,
      slug,
      memberships: { create: { userId: user.id, role: Role.owner } },
    },
  });

  const { token, session } = await createSession(user.id);
  await setSessionCookie(token, session.expiresAt);

  redirect(`/o/${organisation.slug}`);
}
