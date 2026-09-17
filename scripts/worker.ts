import { purgeExpiredSessions } from '../src/lib/auth/session';
import { assertTenantIsolationActive, disconnect } from '../src/lib/db/tenant';
import { closeQueue } from '../src/lib/jobs/queue';
import { enforceRetention } from '../src/lib/jobs/retention';
import { startScanWorker } from '../src/lib/jobs/scan-worker';
import { enqueueDueScans } from '../src/lib/jobs/scheduler';

/**
 * The background process: one scan worker plus two timers.
 *
 * Refuses to start unless row-level security is verifiably in force. The
 * worker writes tenant data on behalf of every organisation, so a
 * misconfigured connection here is the highest-blast-radius mistake in the
 * system and the check is cheaper than the incident.
 */
const SCHEDULER_INTERVAL_MS = 60_000;
const HOUSEKEEPING_INTERVAL_MS = 6 * 60 * 60 * 1000;

async function main(): Promise<void> {
  await assertTenantIsolationActive();

  const worker = startScanWorker();
  process.stdout.write('scan worker started\n');

  const scheduler = setInterval(() => {
    enqueueDueScans().then(
      (count) => {
        if (count > 0) process.stdout.write(`scheduler: queued ${count} scan(s)\n`);
      },
      (error: unknown) => process.stderr.write(`scheduler failed: ${String(error)}\n`),
    );
  }, SCHEDULER_INTERVAL_MS);

  const housekeeping = setInterval(() => {
    Promise.all([enforceRetention(), purgeExpiredSessions()]).then(
      ([retention, sessions]) =>
        process.stdout.write(
          `housekeeping: ${retention.scanRunsDeleted} scan run(s) past retention, ${sessions} expired session(s)\n`,
        ),
      (error: unknown) => process.stderr.write(`housekeeping failed: ${String(error)}\n`),
    );
  }, HOUSEKEEPING_INTERVAL_MS);

  const shutdown = async (): Promise<void> => {
    clearInterval(scheduler);
    clearInterval(housekeeping);
    await worker.close();
    await closeQueue();
    await disconnect();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

main().catch((error: unknown) => {
  process.stderr.write(`worker failed to start: ${String(error)}\n`);
  process.exit(1);
});
