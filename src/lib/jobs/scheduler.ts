import { ScanStatus } from '@prisma/client';

import { administrativeDb } from '@/lib/db/tenant';
import { enqueueScan } from '@/lib/jobs/queue';

/**
 * Enqueues the scans that are due.
 *
 * Schedules live in Postgres and this reads them, rather than registering a
 * BullMQ repeatable job per site. Repeatable jobs would be a second copy of
 * the schedule that has to be kept in step with the database every time a
 * frequency changes, a site is deleted, or an organisation is suspended -- and
 * the two drift silently when it is not. One source of truth, polled.
 *
 * Runs as the owner connection because it deliberately works across every
 * organisation; the per-scan work it enqueues is tenant-scoped.
 */
export async function enqueueDueScans(now: Date = new Date()): Promise<number> {
  const due = await administrativeDb.site.findMany({
    where: {
      deletedAt: null,
      verifiedAt: { not: null },
      nextScanAt: { lte: now },
      organisation: { deletedAt: null },
    },
    select: { id: true, organisationId: true },
    // Bounded so one tick cannot enqueue an unbounded amount of work.
    take: 500,
  });

  let enqueued = 0;
  for (const site of due) {
    // Created first so the run is visible in the UI as queued, and so its id
    // can serve as the job id and make a duplicate enqueue a no-op.
    const run = await administrativeDb.scanRun.create({
      data: {
        organisationId: site.organisationId,
        siteId: site.id,
        status: ScanStatus.queued,
      },
      select: { id: true },
    });

    // Cleared immediately: the worker sets the next one on success, so a
    // scheduler tick that runs again before the scan finishes does not queue
    // the same site twice.
    await administrativeDb.site.update({
      where: { id: site.id },
      data: { nextScanAt: null },
    });

    await enqueueScan({
      organisationId: site.organisationId,
      siteId: site.id,
      scanRunId: run.id,
    });
    enqueued += 1;
  }

  return enqueued;
}
