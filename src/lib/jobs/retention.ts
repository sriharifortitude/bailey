import { administrativeDb } from '@/lib/db/tenant';

/**
 * Deletes scan history older than each organisation's configured retention
 * window.
 *
 * Only ScanRun and Finding rows are pruned, not Issue or IssueEvent. That
 * split is deliberate: a Finding carries the raw evidence a scan captured --
 * response headers, markup snippets, certificate detail -- which is exactly
 * the kind of data that should not accumulate indefinitely, and is the actual
 * subject of a retention policy. An Issue is the current triage record for a
 * problem, not a piece of scan history; deleting it because it is old would
 * throw away "was this ever accepted, and why" for a problem that might still
 * be relevant. Findings cascade-delete with their ScanRun, which is why only
 * the runs are targeted here.
 *
 * Runs per organisation rather than as one global query so each
 * organisation's own retentionDays setting applies, and so one very large
 * organisation's deletion does not become a single unbounded transaction.
 */
export async function enforceRetention(now: Date = new Date()): Promise<{ organisations: number; scanRunsDeleted: number }> {
  const organisations = await administrativeDb.organisation.findMany({
    where: { deletedAt: null },
    select: { id: true, scanRetentionDays: true },
  });

  let scanRunsDeleted = 0;

  for (const organisation of organisations) {
    const cutoff = new Date(now.getTime() - organisation.scanRetentionDays * 24 * 60 * 60 * 1000);

    const result = await administrativeDb.scanRun.deleteMany({
      where: { organisationId: organisation.id, queuedAt: { lt: cutoff }, status: { in: ['succeeded', 'failed'] } },
    });
    scanRunsDeleted += result.count;
  }

  return { organisations: organisations.length, scanRunsDeleted };
}
