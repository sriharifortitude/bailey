'use server';

import { redirect } from 'next/navigation';
import { Role } from '@prisma/client';

import { requireSession } from '@/lib/auth/current-session';
import { administrativeDb } from '@/lib/db/tenant';
import { generateUniqueSlug } from '@/lib/org/slug';
import { formString } from '@/lib/forms';

function back(message: string): never {
  redirect(`/onboarding?error=${encodeURIComponent(message)}`);
}

export async function createOrganisationAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const name = formString(formData, 'name').trim();
  if (name === '') back('Enter a name for your organisation or team.');

  const slug = await generateUniqueSlug(name);
  const organisation = await administrativeDb.organisation.create({
    data: {
      name,
      slug,
      memberships: { create: { userId: session.user.id, role: Role.owner } },
    },
  });

  redirect(`/o/${organisation.slug}`);
}
