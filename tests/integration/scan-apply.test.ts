import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { IssueStatus, ScanStatus } from '@prisma/client';

import { administrativeDb, disconnect, withOrganisation } from '@/lib/db/tenant';
import { applyScanResult, recordScanFailure } from '@/lib/scans/apply';
import type { ScanObservation } from '@/lib/scans/reconcile';
import type { ScanResult } from '@/lib/scans/scanner';
import { resetDatabase, seedOrganisation, type SeededOrganisation } from '../helpers/fixtures';

/**
 * The full cycle against a real database: a scan opens issues, a later scan
 * closes one, and a later scan still brings it back as a regression.
 *
 * This is the behaviour the product is sold on, so it is tested through the
 * same tenant-scoped path the application uses rather than against the
 * reconciler in isolation.
 */

const CSP: ScanObservation = {
  findingKey: 'headers/csp/missing',
  checkId: 'headers/csp',
  category: 'headers',
  severity: 'medium',
  confidence: 'firm',
  title: 'No Content-Security-Policy',
  summary: 'The response carries no Content-Security-Policy.',
  remediation: 'Introduce a nonce-based policy.',
  targetUrl: 'https://client.example.com/',
  evidence: [{ kind: 'missing-header', name: 'content-security-policy' }],
};

const HSTS: ScanObservation = {
  findingKey: 'headers/hsts/missing',
  checkId: 'headers/hsts',
  category: 'headers',
  severity: 'medium',
  confidence: 'firm',
  title: 'No Strict-Transport-Security header',
  summary: 'The origin does not instruct browsers to use https exclusively.',
  remediation: 'Send Strict-Transport-Security.',
  targetUrl: 'https://client.example.com/',
  evidence: [],
};

function scan(
  observations: ScanObservation[],
  checksNotRun: string[] = [],
): ScanResult {
  return {
    scannerVersion: '0.1.0',
    observations,
    checksNotRun,
    requestCount: 16,
    warnings: [],
  };
}

describe('applying scan results', () => {
  let org: SeededOrganisation;
  let context: { userId: string; organisationId: string };

  beforeEach(async () => {
    await resetDatabase();
    org = await seedOrganisation('alpha');
    context = { userId: org.ownerUserId, organisationId: org.organisationId };
  });

  afterAll(async () => {
    await disconnect();
  });

  /** Creates a scan run, applies the result, and returns both. */
  async function applyScanResultFor(result: ScanResult) {
    const run = await administrativeDb.scanRun.create({
      data: {
        organisationId: org.organisationId,
        siteId: org.siteId,
        status: ScanStatus.running,
        startedAt: new Date(),
      },
    });
    const summary = await applyScanResult(context, {
      siteId: org.siteId,
      scanRunId: run.id,
      result,
    });
    return { summary, runId: run.id };
  }

  function issues() {
    return withOrganisation(context, (db) =>
      db.issue.findMany({ orderBy: { findingKey: 'asc' } }),
    );
  }

  it('opens an issue per finding on a first scan', async () => {
    const { summary } = await applyScanResultFor(scan([CSP, HSTS]));

    expect(summary.opened).toBe(2);
    const opened = await issues();
    expect(opened.map((issue) => issue.findingKey)).toEqual([
      'headers/csp/missing',
      'headers/hsts/missing',
    ]);
    expect(opened.every((issue) => issue.status === IssueStatus.open)).toBe(true);
  });

  it('attaches a finding to every observation and links it to its issue', async () => {
    await applyScanResultFor(scan([CSP, HSTS]));

    const findings = await withOrganisation(context, (db) =>
      db.finding.findMany({ include: { issue: true } }),
    );
    expect(findings).toHaveLength(2);
    for (const finding of findings) {
      expect(finding.issue.findingKey).toBe(finding.findingKey);
    }
  });

  it('records the run summary and severity counts on the scan run', async () => {
    const { runId } = await applyScanResultFor(scan([CSP, HSTS]));

    const run = await administrativeDb.scanRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe(ScanStatus.succeeded);
    expect(run.mediumCount).toBe(2);
    expect(run.criticalCount).toBe(0);
    expect(run.requestCount).toBe(16);
    expect(run.scannerVersion).toBe('0.1.0');
    expect(run.finishedAt).not.toBeNull();
  });

  it('does not open a second issue when the same finding is seen again', async () => {
    await applyScanResultFor(scan([CSP, HSTS]));
    const { summary } = await applyScanResultFor(scan([CSP, HSTS]));

    expect(summary.opened).toBe(0);
    expect(await issues()).toHaveLength(2);
    // A second finding row is created each scan: findings are the per-run
    // evidence, issues are the durable thing.
    const findings = await withOrganisation(context, (db) => db.finding.count());
    expect(findings).toBe(4);
  });

  it('resolves an issue once the finding stops appearing', async () => {
    await applyScanResultFor(scan([CSP, HSTS]));
    const { summary } = await applyScanResultFor(scan([CSP]));

    expect(summary.resolved).toBe(1);
    const [csp, hsts] = await issues();
    expect(csp!.status).toBe(IssueStatus.open);
    expect(hsts!.status).toBe(IssueStatus.resolved);
    expect(hsts!.resolvedAt).not.toBeNull();
  });

  // The behaviour the product exists for.
  it('marks a fixed issue as regressed when it comes back', async () => {
    await applyScanResultFor(scan([CSP, HSTS]));
    await applyScanResultFor(scan([CSP]));
    const { summary } = await applyScanResultFor(scan([CSP, HSTS]));

    expect(summary.regressed).toBe(1);
    const [, hsts] = await issues();
    expect(hsts!.status).toBe(IssueStatus.regressed);
    // Cleared, so "how long was this fixed for?" is answered by the event
    // history rather than by a stale timestamp.
    expect(hsts!.resolvedAt).toBeNull();
  });

  it('writes an event history that explains how an issue got to its state', async () => {
    await applyScanResultFor(scan([CSP, HSTS]));
    await applyScanResultFor(scan([CSP]));
    await applyScanResultFor(scan([CSP, HSTS]));

    const events = await withOrganisation(context, (db) =>
      db.issueEvent.findMany({
        where: { issue: { findingKey: 'headers/hsts/missing' } },
        orderBy: { createdAt: 'asc' },
      }),
    );

    expect(events.map((event) => event.type)).toEqual(['opened', 'auto_resolved', 'regressed']);
  });

  /**
   * The failure this exists to prevent: a scan where the TLS handshake failed
   * reports no TLS findings, and resolving those issues would quietly close
   * real problems on evidence nobody gathered.
   */
  it('leaves issues alone when their check did not run', async () => {
    await applyScanResultFor(scan([CSP, HSTS]));

    const { summary } = await applyScanResultFor(scan([CSP], ['headers/hsts']));

    expect(summary.resolved).toBe(0);
    expect(summary.notEvaluated).toBe(1);
    const [, hsts] = await issues();
    expect(hsts!.status).toBe(IssueStatus.open);
  });

  it('records a severity change without reopening the issue', async () => {
    await applyScanResultFor(scan([CSP]));
    await applyScanResultFor(scan([{ ...CSP, severity: 'critical' }]));

    const [csp] = await issues();
    expect(csp!.severity).toBe('critical');
    expect(csp!.status).toBe(IssueStatus.open);

    const events = await withOrganisation(context, (db) =>
      db.issueEvent.findMany({ where: { type: 'severity_changed' } }),
    );
    expect(events[0]?.note).toBe('medium to critical');
  });

  describe('a scan that failed', () => {
    it('is recorded without touching any issue', async () => {
      await applyScanResultFor(scan([CSP, HSTS]));

      const run = await administrativeDb.scanRun.create({
        data: {
          organisationId: org.organisationId,
          siteId: org.siteId,
          status: ScanStatus.running,
          startedAt: new Date(),
        },
      });
      await recordScanFailure(context, { scanRunId: run.id, reason: 'connect ETIMEDOUT' });

      const stored = await administrativeDb.scanRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(stored.status).toBe(ScanStatus.failed);
      expect(stored.failureReason).toBe('connect ETIMEDOUT');

      // The point: nothing was resolved on the strength of a scan that
      // observed nothing.
      const after = await issues();
      expect(after.every((issue) => issue.status === IssueStatus.open)).toBe(true);
    });

    it('truncates a long failure reason rather than storing a page of output', async () => {
      const run = await administrativeDb.scanRun.create({
        data: {
          organisationId: org.organisationId,
          siteId: org.siteId,
          status: ScanStatus.running,
          startedAt: new Date(),
        },
      });
      await recordScanFailure(context, { scanRunId: run.id, reason: 'x'.repeat(2000) });

      const stored = await administrativeDb.scanRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(stored.failureReason).toHaveLength(500);
    });
  });

  it('keeps everything scoped to the organisation that ran the scan', async () => {
    await applyScanResultFor(scan([CSP, HSTS]));

    const beta = await seedOrganisation('beta');
    const betaIssues = await withOrganisation(
      { userId: beta.ownerUserId, organisationId: beta.organisationId },
      (db) => db.issue.findMany(),
    );

    expect(betaIssues).toEqual([]);
  });
});
