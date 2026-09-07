import { Queue } from 'bullmq';
import IORedis from 'ioredis';

import { env } from '@/lib/env';
import type { ScanJobPayload } from '@/lib/scans/run-job';

/**
 * Redis carries the work queue only. It holds no tenant data: a job is three
 * identifiers, and everything the worker needs is read from Postgres through
 * the tenant-scoped path. That keeps the row-level security boundary intact --
 * a queue is not a place to smuggle rows past it -- and means losing Redis
 * costs pending work, not customer data.
 */

export const SCAN_QUEUE = 'scans';

// BullMQ requires this: its blocking commands must not be retried by the
// client, or a reconnect turns into a stalled worker.
export const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

export const scanQueue = new Queue<ScanJobPayload>(SCAN_QUEUE, {
  connection,
  defaultJobOptions: {
    // Two attempts, not five. A scan that failed because the origin is down
    // will fail again, and hammering someone's site on our own initiative is
    // exactly what the rest of this codebase is careful not to do.
    attempts: 2,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 7 * 24 * 3600 },
  },
});

/**
 * The scan run row is created first and its id becomes the job id, so a
 * duplicate enqueue -- a retried request, a scheduler that ran twice -- is
 * rejected by BullMQ instead of scanning the site twice.
 */
export async function enqueueScan(payload: ScanJobPayload): Promise<void> {
  await scanQueue.add('scan', payload, { jobId: payload.scanRunId });
}

export async function closeQueue(): Promise<void> {
  await scanQueue.close();
  connection.disconnect();
}
