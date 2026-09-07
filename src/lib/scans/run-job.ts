import { ScanStatus } from '@prisma/client';

import { withOrganisation, type RequestContext } from '@/lib/db/tenant';
import { applyScanResult, recordScanFailure, type ApplyScanSummary } from '@/lib/scans/apply';
import { runScan, type ScanResult } from '@/lib/scans/scanner';
import { verificationIsStale, verifyOwnership } from '@/lib/sites/verification';

/**
 * What happens when a scan job is processed, separated from the queue that
 * delivers it.
 *
 * The BullMQ worker is thin wiring around this. Keeping the decisions here --
 * whether the site may be scanned at all, what to do when verification has
 * lapsed, how a failure is recorded -- means they are testable against a real
 * database without a Redis instance, and that swapping the queue later would
 * not touch any of them.
 */

export interface ScanJobPayload {
  readonly organisationId: string;
  readonly siteId: string;
  readonly scanRunId: string;
  /** Absent for a scheduled scan; present when a person pressed the button. */
  readonly requestedByUserId?: string;
}

export type ScanJobOutcome =
  | { readonly status: 'succeeded'; readonly summary: ApplyScanSummary }
  | { readonly status: 'failed'; readonly reason: string };

export interface ScanJobDependencies {
  readonly scan: (origin: string) => Promise<ScanResult>;
  readonly verify: typeof verifyOwnership;
  readonly now: () => Date;
}

const productionDependencies: ScanJobDependencies = {
  scan: (origin) => runScan(origin),
  verify: verifyOwnership,
  now: () => new Date(),
};

export async function runScanJob(
  payload: ScanJobPayload,
  dependencies: Partial<ScanJobDependencies> = {},
): Promise<ScanJobOutcome> {
  const deps = { ...productionDependencies, ...dependencies };
  const now = deps.now();

  // The job carries an organisation id, but it is not trusted as authority:
  // every read and write below still goes through the tenant-scoped path, so
  // a malformed or replayed job cannot reach another organisation's rows.
  const context: RequestContext = {
    userId: payload.requestedByUserId ?? SYSTEM_ACTOR,
    organisationId: payload.organisationId,
  };

  const site = await withOrganisation(context, (db) =>
    db.site.findFirst({
      where: { id: payload.siteId, deletedAt: null },
      select: {
        id: true,
        origin: true,
        verifiedAt: true,
        verificationCheckedAt: true,
        verificationMethod: true,
        verificationToken: true,
        scanFrequency: true,
      },
    }),
  );

  if (site === null) {
    return fail(context, payload.scanRunId, 'The site no longer exists.', now);
  }

  if (site.verifiedAt === null) {
    return fail(
      context,
      payload.scanRunId,
      'Ownership of this domain has not been verified.',
      now,
    );
  }

  /**
   * Verification is re-checked when it goes stale rather than trusted forever.
   * A domain changes hands, and continuing to send traffic on behalf of a
   * customer who no longer controls it is the same abuse problem arriving
   * slowly. A failed re-check clears the verification, so the site stops being
   * scanned until someone proves control again.
   */
  if (verificationIsStale(site.verificationCheckedAt, now)) {
    const outcome = await deps.verify(
      site.origin,
      site.verificationMethod,
      site.verificationToken,
    );

    await withOrganisation(context, (db) =>
      db.site.update({
        where: { id: site.id },
        data: outcome.verified
          ? { verificationCheckedAt: now }
          : { verificationCheckedAt: now, verifiedAt: null },
      }),
    );

    if (!outcome.verified) {
      return fail(
        context,
        payload.scanRunId,
        `Ownership could not be re-confirmed: ${outcome.reason}`,
        now,
      );
    }
  }

  await withOrganisation(context, (db) =>
    db.scanRun.update({
      where: { id: payload.scanRunId },
      data: { status: ScanStatus.running, startedAt: now },
    }),
  );

  let result: ScanResult;
  try {
    result = await deps.scan(site.origin);
  } catch (error) {
    // A scan that did not complete observed nothing. It is recorded as a
    // failure and reconciliation is not run, so no issue is resolved on the
    // strength of a scan that never happened.
    return fail(
      context,
      payload.scanRunId,
      error instanceof Error ? error.message : 'The scan failed.',
      now,
    );
  }

  const summary = await applyScanResult(context, {
    siteId: site.id,
    scanRunId: payload.scanRunId,
    result,
    now,
  });

  await withOrganisation(context, (db) =>
    db.site.update({
      where: { id: site.id },
      data: { nextScanAt: nextScanAfter(site.scanFrequency, now) },
    }),
  );

  return { status: 'succeeded', summary };
}

async function fail(
  context: RequestContext,
  scanRunId: string,
  reason: string,
  now: Date,
): Promise<ScanJobOutcome> {
  await recordScanFailure(context, { scanRunId, reason, now });
  return { status: 'failed', reason };
}

/**
 * A scan run is attributed to a person when one asked for it, and to this
 * fixed identifier when the scheduler did. It is a real UUID because the
 * tenant guard validates the shape before it reaches a policy expression.
 */
export const SYSTEM_ACTOR = '00000000-0000-4000-8000-000000000000';

export function nextScanAfter(
  frequency: 'manual' | 'daily' | 'weekly',
  from: Date,
): Date | null {
  const day = 24 * 60 * 60 * 1000;
  switch (frequency) {
    case 'daily':
      return new Date(from.getTime() + day);
    case 'weekly':
      return new Date(from.getTime() + 7 * day);
    case 'manual':
      return null;
  }
}
