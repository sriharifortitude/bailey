'use server';

import { redirect } from 'next/navigation';
import { ScanStatus } from '@prisma/client';

import { requireMembership } from '@/lib/auth/current-session';
import { withOrganisation } from '@/lib/db/tenant';
import { enqueueScan } from '@/lib/jobs/queue';
import { assertCan } from '@/lib/policy/rbac';
import { verifyOwnership } from '@/lib/sites/verification';
import { formString } from '@/lib/forms';

function back(orgSlug: string, siteId: string, message: string, kind: 'error' | 'success' = 'error'): never {
  const param = kind === 'error' ? 'error' : 'success';
  redirect(`/o/${orgSlug}/sites/${siteId}?${param}=${encodeURIComponent(message)}`);
}

export async function checkVerificationAction(formData: FormData): Promise<void> {
  const orgSlug = formString(formData, 'orgSlug');
  const siteId = formString(formData, 'siteId');
  const { role, context } = await requireMembership(orgSlug);
  assertCan(role, 'site:verify');

  const site = await withOrganisation(context, (db) =>
    db.site.findUniqueOrThrow({
      where: { id: siteId },
      select: { origin: true, verificationMethod: true, verificationToken: true },
    }),
  );

  const outcome = await verifyOwnership(site.origin, site.verificationMethod, site.verificationToken);
  const now = new Date();

  await withOrganisation(context, (db) =>
    db.site.update({
      where: { id: siteId },
      data: outcome.verified
        ? { verifiedAt: now, verificationCheckedAt: now }
        : { verificationCheckedAt: now },
    }),
  );

  back(
    orgSlug,
    siteId,
    outcome.verified ? 'Ownership confirmed. Scans can now run.' : `Not verified yet: ${outcome.reason}`,
    outcome.verified ? 'success' : 'error',
  );
}

export async function triggerScanAction(formData: FormData): Promise<void> {
  const orgSlug = formString(formData, 'orgSlug');
  const siteId = formString(formData, 'siteId');
  const { role, context, user } = await requireMembership(orgSlug);
  assertCan(role, 'scan:trigger');

  const site = await withOrganisation(context, (db) =>
    db.site.findUniqueOrThrow({ where: { id: siteId }, select: { verifiedAt: true } }),
  );
  if (site.verifiedAt === null) {
    back(orgSlug, siteId, 'Verify ownership of this site before scanning it.');
  }

  const alreadyRunning = await withOrganisation(context, (db) =>
    db.scanRun.findFirst({
      where: { siteId, status: { in: [ScanStatus.queued, ScanStatus.running] } },
      select: { id: true },
    }),
  );
  if (alreadyRunning !== null) back(orgSlug, siteId, 'A scan is already in progress for this site.');

  const run = await withOrganisation(context, (db) =>
    db.scanRun.create({ data: { organisationId: context.organisationId, siteId, status: ScanStatus.queued } }),
  );

  await enqueueScan({
    organisationId: context.organisationId,
    siteId,
    scanRunId: run.id,
    requestedByUserId: user.id,
  });

  back(orgSlug, siteId, 'Scan queued.', 'success');
}

export async function updateFrequencyAction(formData: FormData): Promise<void> {
  const orgSlug = formString(formData, 'orgSlug');
  const siteId = formString(formData, 'siteId');
  const { role, context } = await requireMembership(orgSlug);
  assertCan(role, 'site:update');

  const raw = (formString(formData, 'frequency') || 'manual');
  const frequency = raw === 'daily' || raw === 'weekly' ? raw : 'manual';

  await withOrganisation(context, (db) =>
    db.site.update({ where: { id: siteId }, data: { scanFrequency: frequency } }),
  );

  back(orgSlug, siteId, 'Scan schedule updated.', 'success');
}

export async function deleteSiteAction(formData: FormData): Promise<void> {
  const orgSlug = formString(formData, 'orgSlug');
  const siteId = formString(formData, 'siteId');
  const { role, context } = await requireMembership(orgSlug);
  assertCan(role, 'site:delete');

  // Soft delete: the scan and finding history stays intact for the audit
  // trail, and the site simply stops appearing or being scheduled.
  await withOrganisation(context, (db) =>
    db.site.update({ where: { id: siteId }, data: { deletedAt: new Date(), nextScanAt: null } }),
  );

  redirect(`/o/${orgSlug}?success=${encodeURIComponent('Site removed.')}`);
}
