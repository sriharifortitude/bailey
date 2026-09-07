import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { ScannerError, parseScannerOutput } from '@/lib/scans/scanner';

/**
 * The fixture is a real report, captured by running the scanner against
 * example.com, not hand-written JSON. If the two projects drift apart, this is
 * where it shows up -- which is the whole reason to test against a genuine
 * artefact rather than one shaped to match the parser.
 */
const REAL_REPORT = readFileSync('tests/fixtures/parapet-report.json', 'utf8');

describe('parseScannerOutput on a real report', () => {
  const result = parseScannerOutput(REAL_REPORT);

  it('reads the scanner version through, for attribution of changes', () => {
    expect(result.scannerVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('maps every finding to an observation', () => {
    const report = JSON.parse(REAL_REPORT) as { results: Array<{ findings: unknown[] }> };
    expect(result.observations).toHaveLength(report.results[0]!.findings.length);
    expect(result.observations.length).toBeGreaterThan(0);
  });

  it('maps the scanner finding id onto findingKey, which is what fingerprints use', () => {
    const observation = result.observations[0]!;
    expect(observation.findingKey).toMatch(/^[a-z-]+\//);
    expect(observation.checkId).toMatch(/^[a-z-]+\//);
    // findingKey is more specific than checkId: one check yields several.
    expect(observation.findingKey.startsWith(observation.checkId)).toBe(true);
  });

  it('carries the fields a report needs, with nothing empty', () => {
    for (const observation of result.observations) {
      expect(observation.title).not.toBe('');
      expect(observation.summary).not.toBe('');
      expect(observation.remediation).not.toBe('');
      expect(observation.targetUrl).toMatch(/^https?:\/\//);
      expect(['critical', 'high', 'medium', 'low', 'info']).toContain(observation.severity);
    }
  });

  it('records the request count for the run summary', () => {
    expect(result.requestCount).toBeGreaterThan(0);
  });
});

describe('checks that produced no verdict', () => {
  function reportWith(overrides: Record<string, unknown>): string {
    const report = JSON.parse(REAL_REPORT) as { results: Array<Record<string, unknown>> };
    report.results[0] = { ...report.results[0]!, ...overrides };
    return JSON.stringify(report);
  }

  it('treats skipped checks as not run', () => {
    const result = parseScannerOutput(reportWith({ skippedChecks: ['tls/certificate'] }));
    expect(result.checksNotRun).toContain('tls/certificate');
  });

  // A check that threw produced no verdict either, so its issues must survive
  // reconciliation rather than being auto-resolved.
  it('treats an errored check as not run', () => {
    const result = parseScannerOutput(
      reportWith({ checkErrors: [{ checkId: 'cors/misconfiguration', message: 'boom' }] }),
    );
    expect(result.checksNotRun).toContain('cors/misconfiguration');
  });

  it('does not list the same check twice', () => {
    const result = parseScannerOutput(
      reportWith({
        skippedChecks: ['tls/certificate'],
        checkErrors: [{ checkId: 'tls/certificate', message: 'boom' }],
      }),
    );
    expect(result.checksNotRun.filter((id) => id === 'tls/certificate')).toHaveLength(1);
  });

  it('surfaces collector failures as warnings', () => {
    const result = parseScannerOutput(
      reportWith({ collectorErrors: [{ collectorId: 'tls', message: 'handshake timed out' }] }),
    );
    expect(result.warnings.join(' ')).toMatch(/handshake timed out/);
  });
});

describe('rejecting unusable output', () => {
  // Loud, not quiet: a shape change is a deployment problem, and silently
  // producing zero findings would auto-resolve every issue on the site.
  it('throws when the report shape is wrong', () => {
    expect(() => parseScannerOutput('{"tool":{"name":"x"}}')).toThrow(ScannerError);
  });

  it('throws when a severity is not one the platform knows', () => {
    const report = JSON.parse(REAL_REPORT) as {
      results: Array<{ findings: Array<Record<string, unknown>> }>;
    };
    report.results[0]!.findings[0]!['severity'] = 'catastrophic';
    expect(() => parseScannerOutput(JSON.stringify(report))).toThrow(ScannerError);
  });

  it('throws when there is no result for the target', () => {
    expect(() =>
      parseScannerOutput(JSON.stringify({ tool: { name: 'p', version: '1' }, results: [] })),
    ).toThrow(/no result/);
  });
});
