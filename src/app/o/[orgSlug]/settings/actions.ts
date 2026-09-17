'use server';

import { redirect } from 'next/navigation';

import { requireMembership } from '@/lib/auth/current-session';
import { withOrganisation } from '@/lib/db/tenant';
import { assertCan } from '@/lib/policy/rbac';
import { formString } from '@/lib/forms';

function back(orgSlug: string, message: string, kind: 'error' | 'success' = 'error'): never {
  const param = kind === 'error' ? 'error' : 'success';
  redirect(`/o/${orgSlug}/settings?${param}=${encodeURIComponent(message)}`);
}

export async function updateOrganisationAction(formData: FormData): Promise<void> {
  const orgSlug = formString(formData, 'orgSlug');
  const { role, context } = await requireMembership(orgSlug);
  assertCan(role, 'organisation:update');

  const name = formString(formData, 'name').trim();
  if (name === '') back(orgSlug, 'Enter an organisation name.');

  const retentionRaw = Number(formData.get('retentionDays'));
  const retentionDays =
    Number.isInteger(retentionRaw) && retentionRaw >= 30 && retentionRaw <= 3650 ? retentionRaw : 365;

  await withOrganisation(context, (db) =>
    db.organisation.update({
      where: { id: context.organisationId },
      data: { name, scanRetentionDays: retentionDays },
    }),
  );

  back(orgSlug, 'Settings saved.', 'success');
}

export async function deleteOrganisationAction(formData: FormData): Promise<void> {
  const orgSlug = formString(formData, 'orgSlug');
  const confirmation = formString(formData, 'confirmation');
  const { role, context, organisation } = await requireMembership(orgSlug);
  assertCan(role, 'organisation:delete');

  if (confirmation !== organisation.name) {
    back(orgSlug, 'Type the organisation name exactly to confirm deletion.');
  }

  // Soft delete: scan history and audit events are retained (the audit log
  // exists to answer "what happened", including after an org is gone), and
  // the slug is freed by nobody -- the unique constraint stays satisfied by
  // the row still existing, so a deleted organisation's slug cannot be
  // squatted by a different one immediately after.
  await withOrganisation(context, (db) =>
    db.organisation.update({ where: { id: context.organisationId }, data: { deletedAt: new Date() } }),
  );

  redirect('/select-org');
}
