'use server';

import { redirect } from 'next/navigation';
import { VerificationMethod } from '@prisma/client';

import { requireMembership } from '@/lib/auth/current-session';
import { withOrganisation } from '@/lib/db/tenant';
import { assertCan } from '@/lib/policy/rbac';
import { InvalidOriginError, assertOriginIsPubliclyRoutable, normaliseOrigin } from '@/lib/sites/origin';
import { generateVerificationToken } from '@/lib/sites/verification';
import { formString } from '@/lib/forms';

function back(orgSlug: string, message: string): never {
  redirect(`/o/${orgSlug}/sites/new?error=${encodeURIComponent(message)}`);
}

export async function addSiteAction(formData: FormData): Promise<void> {
  const orgSlug = formString(formData, 'orgSlug');
  const { role, context } = await requireMembership(orgSlug);
  assertCan(role, 'site:create');

  const label = formString(formData, 'label').trim();
  const rawOrigin = formString(formData, 'origin').trim();
  const method =
    formData.get('method') === 'well_known_file'
      ? VerificationMethod.well_known_file
      : VerificationMethod.dns_txt;

  if (label === '') back(orgSlug, 'Enter a name for this site.');

  let origin: string;
  try {
    origin = normaliseOrigin(rawOrigin);
    await assertOriginIsPubliclyRoutable(origin);
  } catch (error) {
    back(orgSlug, error instanceof InvalidOriginError ? error.message : 'That address could not be used.');
  }

  const token = generateVerificationToken();

  let siteId: string;
  try {
    const site = await withOrganisation(context, (db) =>
      db.site.create({
        data: {
          organisationId: context.organisationId,
          label,
          origin,
          verificationMethod: method,
          verificationToken: token,
        },
        select: { id: true },
      }),
    );
    siteId = site.id;
  } catch (error) {
    // The unique constraint on (organisationId, origin): the friendliest
    // response is to send them to the site that already exists rather than a
    // raw constraint-violation message.
    if (error instanceof Error && error.message.includes('Unique constraint')) {
      const existing = await withOrganisation(context, (db) =>
        db.site.findFirst({ where: { origin }, select: { id: true } }),
      );
      if (existing !== null) redirect(`/o/${orgSlug}/sites/${existing.id}`);
    }
    back(orgSlug, 'This site could not be added.');
  }

  redirect(`/o/${orgSlug}/sites/${siteId}`);
}
