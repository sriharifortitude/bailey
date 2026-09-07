import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IssueStatus, ScanStatus, VerificationMethod } from '@prisma/client';

import { administrativeDb, disconnect, withOrganisation } from '@/lib/db/tenant';
import { nextScanAfter, runScanJob } from '@/lib/scans/run-job';
import type { ScanObservation } from '@/lib/scans/reconcile';
import type { ScanResult } from '@/lib/scans/scanner';
import { VERIFICATION_VALID_FOR_MS } from '@/lib/sites/verification';
import { resetDatabase, seedOrganisation, type SeededOrganisation } from '../helpers/fixtures';

/**
 * The job's decisions, against a real database, with the scanner and the
 * ownership check injected. What is being tested is when a scan is allowed to
 * happen at all and what is recorded when it is not -- none of which needs a
 * network or a queue.
 */

const FINDING: ScanObservation = {
  findingKey: 'headers/csp/missing',
  checkId: 'headers/csp',
  category: 'headers',
  severity: 'medium',
  confidence: 'firm',
  title: 'No Content-Security-Policy',
  summary: 'The response carries no Content-Security-Policy.',
  remediation: 'Introduce a nonce-based policy.',
  targetUrl: 'https://client.example.com/',
  evidence: [],
};

const CLEAN_RESULT: ScanResult = {
  scannerVersion: '0.1.0',
  observations: [FINDING],
  checksNotRun: [],
  requestCount: 16,
  warnings: [],
};

describe('runScanJob', () => {
  let org: SeededOrganisation;

  beforeEach(async () => {
    await resetDatabase();
    org = await seedOrganisation('alpha');
    // seedOrganisation verifies the site but leaves the re-check date unset.
    await administrativeDb.site.update({
      where: { id: org.siteId },
      data: { verificationCheckedAt: new Date(), scanFrequency: 'daily' },
    });
  });

  afterAll(async () => {
    await disconnect();
  });

  async function queueRun(): Promise<string> {
    const run = await administrativeDb.scanRun.create({
      data: {
        organisationId: org.organisationId,
        siteId: org.siteId,
        status: ScanStatus.queued,
      },
    });
    return run.id;
  }

  function payload(scanRunId: string) {
    return { organisationId: org.organisationId, siteId: org.siteId, scanRunId };
  }

  const alwaysVerified = vi.fn(() =>
    Promise.resolve({ verified: true as const, method: VerificationMethod.dns_txt }),
  );

  it('scans a verified site and records the findings', async () => {
    const scanRunId = await queueRun();

    const outcome = await runScanJob(payload(scanRunId), {
      scan: () => Promise.resolve(CLEAN_RESULT),
      verify: alwaysVerified,
    });

    expect(outcome).toMatchObject({ status: 'succeeded' });
    const run = await administrativeDb.scanRun.findUniqueOrThrow({ where: { id: scanRunId } });
    expect(run.status).toBe(ScanStatus.succeeded);
    expect(await administrativeDb.issue.count()).toBe(1);
  });

  it('schedules the next scan according to the site frequency', async () => {
    const scanRunId = await queueRun();
    const now = new Date('2026-06-01T09:00:00Z');

    await runScanJob(payload(scanRunId), {
      scan: () => Promise.resolve(CLEAN_RESULT),
      verify: alwaysVerified,
      now: () => now,
    });

    const site = await administrativeDb.site.findUniqueOrThrow({ where: { id: org.siteId } });
    expect(site.nextScanAt).toEqual(new Date('2026-06-02T09:00:00Z'));
  });

  it('leaves a manual site unscheduled', async () => {
    await administrativeDb.site.update({
      where: { id: org.siteId },
      data: { scanFrequency: 'manual' },
    });
    const scanRunId = await queueRun();

    await runScanJob(payload(scanRunId), {
      scan: () => Promise.resolve(CLEAN_RESULT),
      verify: alwaysVerified,
    });

    const site = await administrativeDb.site.findUniqueOrThrow({ where: { id: org.siteId } });
    expect(site.nextScanAt).toBeNull();
  });

  describe('refusing to scan', () => {
    // The control that stops the platform being an open relay for scans.
    it('refuses a site whose ownership was never verified', async () => {
      await administrativeDb.site.update({
        where: { id: org.siteId },
        data: { verifiedAt: null },
      });
      const scanRunId = await queueRun();
      const scan = vi.fn();

      const outcome = await runScanJob(payload(scanRunId), { scan, verify: alwaysVerified });

      expect(outcome).toMatchObject({ status: 'failed' });
      expect(scan).not.toHaveBeenCalled();
      const run = await administrativeDb.scanRun.findUniqueOrThrow({ where: { id: scanRunId } });
      expect(run.status).toBe(ScanStatus.failed);
      expect(run.failureReason).toMatch(/not been verified/);
    });

    it('refuses a site that has been deleted', async () => {
      await administrativeDb.site.update({
        where: { id: org.siteId },
        data: { deletedAt: new Date() },
      });
      const scanRunId = await queueRun();
      const scan = vi.fn();

      const outcome = await runScanJob(payload(scanRunId), { scan, verify: alwaysVerified });

      expect(outcome).toMatchObject({ status: 'failed' });
      expect(scan).not.toHaveBeenCalled();
    });
  });

  describe('stale verification', () => {
    async function makeStale(): Promise<void> {
      await administrativeDb.site.update({
        where: { id: org.siteId },
        data: {
          verificationCheckedAt: new Date(Date.now() - VERIFICATION_VALID_FOR_MS - 1000),
        },
      });
    }

    it('re-checks ownership before scanning, and proceeds when it still holds', async () => {
      await makeStale();
      const scanRunId = await queueRun();
      const verify = vi.fn(() =>
        Promise.resolve({ verified: true as const, method: VerificationMethod.dns_txt }),
      );

      const outcome = await runScanJob(payload(scanRunId), {
        scan: () => Promise.resolve(CLEAN_RESULT),
        verify,
      });

      expect(verify).toHaveBeenCalledOnce();
      expect(outcome).toMatchObject({ status: 'succeeded' });
    });

    /**
     * A domain that changed hands. Continuing to send traffic on behalf of a
     * customer who no longer controls it is the abuse case verification exists
     * to prevent, so the site stops being scanned until someone proves control
     * again.
     */
    it('clears verification and refuses the scan when ownership no longer holds', async () => {
      await makeStale();
      const scanRunId = await queueRun();
      const scan = vi.fn();

      const outcome = await runScanJob(payload(scanRunId), {
        scan,
        verify: () => Promise.resolve({ verified: false as const, reason: 'No TXT record found.' }),
      });

      expect(outcome).toMatchObject({ status: 'failed' });
      expect(scan).not.toHaveBeenCalled();

      const site = await administrativeDb.site.findUniqueOrThrow({ where: { id: org.siteId } });
      expect(site.verifiedAt).toBeNull();
      expect(site.verificationCheckedAt).not.toBeNull();
    });

    it('does not re-check while the verification is still fresh', async () => {
      const scanRunId = await queueRun();
      const verify = vi.fn();

      await runScanJob(payload(scanRunId), {
        scan: () => Promise.resolve(CLEAN_RESULT),
        verify,
      });

      expect(verify).not.toHaveBeenCalled();
    });
  });

  describe('a scan that throws', () => {
    /**
     * The failure this exists to prevent: a scan that never completed observed
     * nothing, and reconciling its empty result would mark every issue on the
     * site as fixed.
     */
    it('records the failure without resolving any issue', async () => {
      const first = await queueRun();
      await runScanJob(payload(first), {
        scan: () => Promise.resolve(CLEAN_RESULT),
        verify: alwaysVerified,
      });

      const second = await queueRun();
      const outcome = await runScanJob(payload(second), {
        scan: () => Promise.reject(new Error('connect ETIMEDOUT')),
        verify: alwaysVerified,
      });

      expect(outcome).toMatchObject({ status: 'failed', reason: 'connect ETIMEDOUT' });

      const run = await administrativeDb.scanRun.findUniqueOrThrow({ where: { id: second } });
      expect(run.status).toBe(ScanStatus.failed);

      const issues = await withOrganisation(
        { userId: org.ownerUserId, organisationId: org.organisationId },
        (db) => db.issue.findMany(),
      );
      expect(issues).toHaveLength(1);
      expect(issues[0]!.status).toBe(IssueStatus.open);
    });

    it('does not advance the next scan time after a failure', async () => {
      await administrativeDb.site.update({
        where: { id: org.siteId },
        data: { nextScanAt: null },
      });
      const scanRunId = await queueRun();

      await runScanJob(payload(scanRunId), {
        scan: () => Promise.reject(new Error('boom')),
        verify: alwaysVerified,
      });

      const site = await administrativeDb.site.findUniqueOrThrow({ where: { id: org.siteId } });
      expect(site.nextScanAt).toBeNull();
    });
  });

  it('cannot reach a site belonging to another organisation', async () => {
    const beta = await seedOrganisation('beta');
    const scanRunId = await queueRun();
    const scan = vi.fn();

    // A job naming alpha's organisation but beta's site: the tenant-scoped
    // read finds nothing, so the job fails rather than scanning across the
    // boundary.
    const outcome = await runScanJob(
      { organisationId: org.organisationId, siteId: beta.siteId, scanRunId },
      { scan, verify: alwaysVerified },
    );

    expect(outcome).toMatchObject({ status: 'failed' });
    expect(scan).not.toHaveBeenCalled();
  });
});

describe('nextScanAfter', () => {
  const from = new Date('2026-06-01T09:00:00Z');

  it.each([
    ['daily', '2026-06-02T09:00:00.000Z'],
    ['weekly', '2026-06-08T09:00:00.000Z'],
  ] as const)('schedules %s', (frequency, expected) => {
    expect(nextScanAfter(frequency, from)?.toISOString()).toBe(expected);
  });

  it('does not schedule a manual site', () => {
    expect(nextScanAfter('manual', from)).toBeNull();
  });
});
