import { Worker } from 'bullmq';

import { SCAN_QUEUE, connection } from '@/lib/jobs/queue';
import { runScanJob, type ScanJobPayload } from '@/lib/scans/run-job';

/**
 * Wiring only. Every decision lives in runScanJob so it can be tested against
 * a real database without Redis.
 */
export function startScanWorker(): Worker<ScanJobPayload> {
  const worker = new Worker<ScanJobPayload>(
    SCAN_QUEUE,
    async (job) => runScanJob(job.data),
    {
      connection,
      // Each job spawns a scanner subprocess, so this is a cap on concurrent
      // subprocesses as much as on database connections.
      concurrency: 4,
      // A scan is bounded by the scanner's own timeout; this is the outer
      // limit before BullMQ considers the job stalled.
      lockDuration: 180_000,
    },
  );

  worker.on('failed', (job, error) => {
    // The job payload is three identifiers, so logging it discloses nothing
    // about the site or its findings.
    process.stderr.write(
      `scan job ${job?.id ?? 'unknown'} failed: ${error.message}\n`,
    );
  });

  return worker;
}
