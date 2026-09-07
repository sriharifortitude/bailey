import { IssueStatus, ScanStatus, type Prisma } from '@prisma/client';

import { withOrganisation, type RequestContext, type TenantClient } from '@/lib/db/tenant';
import {
  countBySeverity,
  fingerprintFor,
  reconcile,
  type ReconciliationPlan,
  type ScanObservation,
} from '@/lib/scans/reconcile';
import type { ScanResult } from '@/lib/scans/scanner';

/**
 * Persists a completed scan: the findings it observed, and the changes those
 * observations imply for the site's issues.
 *
 * All of it happens in one tenant-scoped transaction. A partially applied scan
 * is worse than no scan -- issues resolved but their findings missing, or new
 * issues without the evidence that opened them -- and the site list reads
 * denormalised counts that would then disagree with the rows they summarise.
 */

export interface ApplyScanInput {
  readonly siteId: string;
  readonly scanRunId: string;
  readonly result: ScanResult;
  readonly now?: Date;
}

export interface ApplyScanSummary {
  readonly opened: number;
  readonly regressed: number;
  readonly resolved: number;
  readonly notEvaluated: number;
  readonly total: number;
}

export async function applyScanResult(
  context: RequestContext,
  input: ApplyScanInput,
): Promise<ApplyScanSummary> {
  return withOrganisation(
    context,
    async (db) => persist(db, context.organisationId, input),
    // Larger than the default: a first scan of a badly configured site can
    // open several dozen issues, each with a finding and an event.
    { timeoutMs: 30_000 },
  );
}

async function persist(
  db: TenantClient,
  organisationId: string,
  input: ApplyScanInput,
): Promise<ApplyScanSummary> {
  const now = input.now ?? new Date();
  const { siteId, scanRunId, result } = input;

  const existing = await db.issue.findMany({
    where: { siteId },
    select: {
      id: true,
      fingerprint: true,
      checkId: true,
      status: true,
      severity: true,
      acceptedUntil: true,
    },
  });

  const plan = reconcile({
    siteId,
    observations: result.observations,
    existing,
    checksNotRun: result.checksNotRun,
    now,
  });

  const issueIdByFingerprint = new Map(existing.map((issue) => [issue.fingerprint, issue.id]));

  // Created one at a time because the generated ids are needed to attach the
  // findings below. createMany does not return them.
  for (const { fingerprint, observation } of plan.create) {
    const issue = await db.issue.create({
      data: {
        organisationId,
        siteId,
        fingerprint,
        findingKey: observation.findingKey,
        checkId: observation.checkId,
        category: observation.category,
        severity: observation.severity,
        title: observation.title,
        status: IssueStatus.open,
        firstSeenAt: now,
        lastSeenAt: now,
      },
      select: { id: true },
    });
    issueIdByFingerprint.set(fingerprint, issue.id);
  }

  for (const update of plan.update) {
    await db.issue.update({
      where: { id: update.issueId },
      data: {
        status: update.status,
        severity: update.severity,
        title: update.observation.title,
        lastSeenAt: now,
        // A regression is no longer resolved; clearing the timestamp keeps
        // "how long was this fixed for?" answerable from the event history
        // rather than from a stale field.
        ...(update.status === IssueStatus.regressed ? { resolvedAt: null } : {}),
        ...(update.clearAcceptance ? { acceptedUntil: null, acceptedReason: null } : {}),
      },
    });
  }

  if (plan.resolve.length > 0) {
    await db.issue.updateMany({
      where: { id: { in: plan.resolve.map((entry) => entry.issueId) } },
      data: { status: IssueStatus.resolved, resolvedAt: now },
    });
  }

  await db.finding.createMany({
    data: result.observations.map((observation) =>
      findingRow(organisationId, scanRunId, siteId, issueIdByFingerprint, observation),
    ),
  });

  if (plan.events.length > 0) {
    await db.issueEvent.createMany({
      data: plan.events.flatMap((event) => {
        const issueId = issueIdByFingerprint.get(event.fingerprint);
        if (issueId === undefined) return [];
        return [
          {
            organisationId,
            issueId,
            // Null actor: the platform made this change, not a person.
            type: event.type,
            ...(event.fromStatus === undefined ? {} : { fromStatus: event.fromStatus }),
            ...(event.toStatus === undefined ? {} : { toStatus: event.toStatus }),
            ...(event.note === undefined ? {} : { note: event.note }),
          },
        ];
      }),
    });
  }

  const counts = countBySeverity(result.observations);

  await db.scanRun.update({
    where: { id: scanRunId },
    data: {
      status: ScanStatus.succeeded,
      finishedAt: now,
      scannerVersion: result.scannerVersion,
      requestCount: result.requestCount,
      criticalCount: counts.critical,
      highCount: counts.high,
      mediumCount: counts.medium,
      lowCount: counts.low,
      infoCount: counts.info,
    },
  });

  return summarise(plan, result.observations.length);
}

function findingRow(
  organisationId: string,
  scanRunId: string,
  siteId: string,
  issueIds: ReadonlyMap<string, string>,
  observation: ScanObservation,
): Prisma.FindingCreateManyInput {
  const fingerprint = fingerprintFor(siteId, observation.findingKey, observation.targetUrl);
  const issueId = issueIds.get(fingerprint);
  if (issueId === undefined) {
    // Unreachable: reconcile() either matched an existing issue or planned a
    // creation for every observation. Throwing rather than dropping the row,
    // because a finding with no issue is invisible in the product.
    throw new Error(`No issue was created or matched for finding ${observation.findingKey}.`);
  }

  return {
    organisationId,
    scanRunId,
    siteId,
    issueId,
    findingKey: observation.findingKey,
    checkId: observation.checkId,
    category: observation.category,
    severity: observation.severity,
    confidence: observation.confidence,
    title: observation.title,
    summary: observation.summary,
    remediation: observation.remediation,
    targetUrl: observation.targetUrl,
    evidence: observation.evidence ?? [],
  };
}

function summarise(plan: ReconciliationPlan, total: number): ApplyScanSummary {
  return {
    opened: plan.create.length,
    regressed: plan.events.filter((event) => event.type === 'regressed').length,
    resolved: plan.resolve.length,
    notEvaluated: plan.notEvaluated.length,
    total,
  };
}

/**
 * Records a scan that could not be completed.
 *
 * Deliberately separate from applyScanResult and doing no reconciliation at
 * all: a failed scan observed nothing, so treating its empty result as
 * evidence would resolve every issue on the site. The failure is stored so the
 * site's history shows a gap rather than a suspiciously clean run.
 */
export async function recordScanFailure(
  context: RequestContext,
  input: { readonly scanRunId: string; readonly reason: string; readonly now?: Date },
): Promise<void> {
  await withOrganisation(context, async (db) => {
    await db.scanRun.update({
      where: { id: input.scanRunId },
      data: {
        status: ScanStatus.failed,
        finishedAt: input.now ?? new Date(),
        // Truncated, and never a response body: a failure message that carried
        // page content would put client data somewhere it is not expected.
        failureReason: input.reason.slice(0, 500),
      },
    });
  });
}
