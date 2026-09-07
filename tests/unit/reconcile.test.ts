import { describe, expect, it } from 'vitest';
import { IssueStatus, type Severity } from '@prisma/client';

import {
  countBySeverity,
  fingerprintFor,
  reconcile,
  type ExistingIssue,
  type ScanObservation,
} from '@/lib/scans/reconcile';

const SITE = '11111111-1111-4111-8111-111111111111';

function observation(overrides: Partial<ScanObservation> = {}): ScanObservation {
  return {
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
    ...overrides,
  };
}

function existing(overrides: Partial<ExistingIssue> = {}): ExistingIssue {
  const base = observation();
  return {
    id: 'issue-1',
    fingerprint: fingerprintFor(SITE, base.findingKey, base.targetUrl),
    checkId: base.checkId,
    status: IssueStatus.open,
    severity: 'medium',
    acceptedUntil: null,
    ...overrides,
  };
}

describe('fingerprintFor', () => {
  it('is stable for the same inputs', () => {
    expect(fingerprintFor(SITE, 'a', 'https://x/')).toBe(fingerprintFor(SITE, 'a', 'https://x/'));
  });

  it('differs by site, finding and target', () => {
    const base = fingerprintFor(SITE, 'a', 'https://x/');
    expect(fingerprintFor('other-site', 'a', 'https://x/')).not.toBe(base);
    expect(fingerprintFor(SITE, 'b', 'https://x/')).not.toBe(base);
    expect(fingerprintFor(SITE, 'a', 'https://y/')).not.toBe(base);
  });

  /**
   * The reason severity is excluded: a change to the scanner's rubric must not
   * orphan an issue's triage history and resurface it as new. That is how a
   * monitoring product trains its users to ignore it.
   */
  it('does not change when severity or wording changes', () => {
    const before = fingerprintFor(SITE, 'headers/csp/missing', 'https://x/');
    const after = fingerprintFor(SITE, 'headers/csp/missing', 'https://x/');
    expect(after).toBe(before);
  });

  it('is not ambiguous between adjacent components', () => {
    expect(fingerprintFor(SITE, 'a/', 'b')).not.toBe(fingerprintFor(SITE, 'a', '/b'));
  });
});

describe('reconcile', () => {
  it('opens an issue the first time a finding is seen', () => {
    const plan = reconcile({
      siteId: SITE,
      observations: [observation()],
      existing: [],
      checksNotRun: [],
    });

    expect(plan.create).toHaveLength(1);
    expect(plan.resolve).toEqual([]);
    expect(plan.events.map((event) => event.type)).toEqual(['opened']);
  });

  it('leaves an already open issue open, without an event', () => {
    const plan = reconcile({
      siteId: SITE,
      observations: [observation()],
      existing: [existing()],
      checksNotRun: [],
    });

    expect(plan.create).toEqual([]);
    expect(plan.update).toHaveLength(1);
    expect(plan.update[0]!.status).toBe(IssueStatus.open);
    // Re-observing an open issue every day would bury the real events.
    expect(plan.events).toEqual([]);
  });

  it('resolves an issue that is no longer observed', () => {
    const plan = reconcile({
      siteId: SITE,
      observations: [],
      existing: [existing()],
      checksNotRun: [],
    });

    expect(plan.resolve).toHaveLength(1);
    expect(plan.events.map((event) => event.type)).toEqual(['auto_resolved']);
  });

  // The state the product exists for.
  it('marks a resolved issue as regressed when it reappears', () => {
    const plan = reconcile({
      siteId: SITE,
      observations: [observation()],
      existing: [existing({ status: IssueStatus.resolved })],
      checksNotRun: [],
    });

    expect(plan.update[0]!.status).toBe(IssueStatus.regressed);
    expect(plan.events).toContainEqual(
      expect.objectContaining({
        type: 'regressed',
        fromStatus: IssueStatus.resolved,
        toStatus: IssueStatus.regressed,
      }),
    );
  });

  it('does not re-announce a regression that has not been dealt with', () => {
    const plan = reconcile({
      siteId: SITE,
      observations: [observation()],
      existing: [existing({ status: IssueStatus.regressed })],
      checksNotRun: [],
    });

    expect(plan.update[0]!.status).toBe(IssueStatus.regressed);
    expect(plan.events).toEqual([]);
  });

  it('does not resolve an issue twice', () => {
    const plan = reconcile({
      siteId: SITE,
      observations: [],
      existing: [existing({ status: IssueStatus.resolved })],
      checksNotRun: [],
    });

    expect(plan.resolve).toEqual([]);
    expect(plan.events).toEqual([]);
  });

  describe('accepted risk', () => {
    it('keeps an accepted issue accepted while the acceptance holds', () => {
      const plan = reconcile({
        siteId: SITE,
        observations: [observation()],
        existing: [
          existing({
            status: IssueStatus.accepted,
            acceptedUntil: new Date('2030-01-01T00:00:00Z'),
          }),
        ],
        checksNotRun: [],
        now: new Date('2026-01-01T00:00:00Z'),
      });

      expect(plan.update[0]!.status).toBe(IssueStatus.accepted);
      expect(plan.events).toEqual([]);
    });

    it('reopens an issue whose acceptance has lapsed', () => {
      const plan = reconcile({
        siteId: SITE,
        observations: [observation()],
        existing: [
          existing({
            status: IssueStatus.accepted,
            acceptedUntil: new Date('2025-01-01T00:00:00Z'),
          }),
        ],
        checksNotRun: [],
        now: new Date('2026-01-01T00:00:00Z'),
      });

      expect(plan.update[0]!.status).toBe(IssueStatus.open);
      expect(plan.update[0]!.clearAcceptance).toBe(true);
      expect(plan.events.map((event) => event.type)).toContain('acceptance_expired');
    });

    it('treats a null acceptance date as indefinite', () => {
      const plan = reconcile({
        siteId: SITE,
        observations: [observation()],
        existing: [existing({ status: IssueStatus.accepted, acceptedUntil: null })],
        checksNotRun: [],
      });

      expect(plan.update[0]!.status).toBe(IssueStatus.accepted);
    });

    it('resolves an accepted issue that is genuinely gone', () => {
      const plan = reconcile({
        siteId: SITE,
        observations: [],
        existing: [existing({ status: IssueStatus.accepted })],
        checksNotRun: [],
      });

      expect(plan.resolve).toHaveLength(1);
    });
  });

  /**
   * The failure this guards against: a scan where the TLS handshake failed
   * reports no TLS findings. Treating that as "the TLS problems are fixed"
   * would quietly close real issues on the strength of evidence nobody
   * gathered, and the customer would never know.
   */
  describe('checks that did not run', () => {
    it('does not resolve issues belonging to a check that was skipped', () => {
      const tlsIssue = existing({
        id: 'issue-tls',
        checkId: 'tls/certificate',
        fingerprint: fingerprintFor(SITE, 'tls/certificate/expired', 'https://client.example.com/'),
      });

      const plan = reconcile({
        siteId: SITE,
        observations: [],
        existing: [tlsIssue],
        checksNotRun: ['tls/certificate'],
      });

      expect(plan.resolve).toEqual([]);
      expect(plan.notEvaluated).toEqual(['issue-tls']);
      expect(plan.events).toEqual([]);
    });

    it('still resolves issues from checks that did run in the same scan', () => {
      const tlsIssue = existing({
        id: 'issue-tls',
        checkId: 'tls/certificate',
        fingerprint: 'tls-fingerprint',
      });
      const cspIssue = existing({ id: 'issue-csp' });

      const plan = reconcile({
        siteId: SITE,
        observations: [],
        existing: [tlsIssue, cspIssue],
        checksNotRun: ['tls/certificate'],
      });

      expect(plan.resolve.map((entry) => entry.issueId)).toEqual(['issue-csp']);
      expect(plan.notEvaluated).toEqual(['issue-tls']);
    });
  });

  describe('severity changes', () => {
    it('records a severity change on an issue that stays open', () => {
      const plan = reconcile({
        siteId: SITE,
        observations: [observation({ severity: 'critical' })],
        existing: [existing({ severity: 'medium' })],
        checksNotRun: [],
      });

      expect(plan.update[0]!.severity).toBe('critical');
      expect(plan.events).toContainEqual(
        expect.objectContaining({ type: 'severity_changed', note: 'medium to critical' }),
      );
    });

    it('records nothing when severity is unchanged', () => {
      const plan = reconcile({
        siteId: SITE,
        observations: [observation({ severity: 'medium' })],
        existing: [existing({ severity: 'medium' })],
        checksNotRun: [],
      });

      expect(plan.events).toEqual([]);
    });
  });

  it('handles a realistic mixed scan', () => {
    const stillOpen = existing({ id: 'still-open' });
    const fixed = existing({ id: 'fixed', fingerprint: 'gone-fingerprint' });
    const returning = existing({
      id: 'returning',
      fingerprint: fingerprintFor(SITE, 'cookies/attributes/no-secure:sid', 'https://client.example.com/'),
      status: IssueStatus.resolved,
      checkId: 'cookies/attributes',
    });

    const plan = reconcile({
      siteId: SITE,
      observations: [
        observation(),
        observation({
          findingKey: 'cookies/attributes/no-secure:sid',
          checkId: 'cookies/attributes',
          severity: 'high',
        }),
        observation({ findingKey: 'headers/hsts/missing', checkId: 'headers/hsts' }),
      ],
      existing: [stillOpen, fixed, returning],
      checksNotRun: [],
    });

    expect(plan.create).toHaveLength(1);
    expect(plan.resolve.map((entry) => entry.issueId)).toEqual(['fixed']);
    expect(
      plan.events.filter((event) => event.type === 'regressed').map((event) => event.fingerprint),
    ).toEqual([returning.fingerprint]);
  });
});

describe('countBySeverity', () => {
  it('counts each severity and reports zero for the rest', () => {
    const counts = countBySeverity([
      observation({ severity: 'critical' }),
      observation({ severity: 'high' }),
      observation({ severity: 'high' }),
    ]);

    expect(counts).toEqual({ critical: 1, high: 2, medium: 0, low: 0, info: 0 });
  });

  it('returns all zeroes for an empty scan', () => {
    const counts = countBySeverity([]);
    expect(Object.values(counts).every((count: number) => count === 0)).toBe(true);
    expect(Object.keys(counts).sort()).toEqual(
      (['critical', 'high', 'info', 'low', 'medium'] satisfies Severity[]).sort(),
    );
  });
});
