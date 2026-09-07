import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { ScanObservation } from '@/lib/scans/reconcile';

/**
 * Runs parapet-scan and returns its findings.
 *
 * The scanner runs as a separate process rather than as an imported library.
 * It parses untrusted remote input -- headers, HTML, TLS certificates -- from
 * hosts we do not control, and a subprocess gives that work its own memory,
 * its own crash boundary, and a kill switch. A hung parse takes down a child
 * process instead of a worker that is holding a database transaction.
 *
 * The JSON output is also already parapet's public, versioned interface, so
 * consuming it here keeps the two projects coupled at a documented boundary
 * rather than through its internals.
 */

const findingSchema = z.object({
  id: z.string(),
  checkId: z.string(),
  title: z.string(),
  category: z.string(),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  confidence: z.string(),
  target: z.string(),
  summary: z.string(),
  remediation: z.string(),
  evidence: z.array(z.unknown()).default([]),
});

const reportSchema = z.object({
  tool: z.object({ name: z.string(), version: z.string() }),
  results: z.array(
    z.object({
      target: z.string(),
      findings: z.array(findingSchema),
      collectorErrors: z.array(z.object({ collectorId: z.string(), message: z.string() })),
      checkErrors: z.array(z.object({ checkId: z.string(), message: z.string() })),
      skippedChecks: z.array(z.string()),
      requestCount: z.number(),
    }),
  ),
});

export interface ScanResult {
  readonly scannerVersion: string;
  readonly observations: readonly ScanObservation[];
  /** Checks that produced no verdict, so their issues must not be auto-resolved. */
  readonly checksNotRun: readonly string[];
  readonly requestCount: number;
  readonly warnings: readonly string[];
}

export class ScannerError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'ScannerError';
  }
}

/** Generous enough for a slow origin, short enough that a queue does not stall. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** The scanner writes nothing to stdout in JSON mode; this is only for errors. */
const MAX_STDERR_BYTES = 8192;

function resolveCliPath(): string {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve('parapet-scan/package.json');
  const manifest = require('parapet-scan/package.json') as { bin: Record<string, string> };
  const relative = manifest.bin['parapet'];
  if (relative === undefined) {
    throw new ScannerError('parapet-scan does not expose the expected bin entry.');
  }
  return join(dirname(manifestPath), relative);
}

export interface RunScanOptions {
  readonly timeoutMs?: number;
  /** Skips requests for commonly exposed files. Used for a first pass. */
  readonly probeExposedPaths?: boolean;
}

export async function runScan(
  origin: string,
  options: RunScanOptions = {},
): Promise<ScanResult> {
  const outputPath = join(tmpdir(), `bailey-scan-${randomUUID()}.json`);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const args = [
    resolveCliPath(),
    'scan',
    origin,
    '--format',
    'json',
    '--output',
    outputPath,
    // The platform decides what constitutes a failure; the scanner's own
    // threshold would otherwise turn findings into a non-zero exit.
    '--fail-on',
    'never',
  ];
  if (options.probeExposedPaths === false) args.push('--no-probe-paths');

  try {
    await execute(args, timeoutMs);
    return parseScannerOutput(await readFile(outputPath, 'utf8'));
  } finally {
    await rm(outputPath, { force: true }).catch(() => undefined);
  }
}

function execute(args: readonly string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...args], {
      // No shell: arguments include a user-supplied origin, and a shell would
      // make that an injection surface for no benefit.
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { PATH: process.env['PATH'] ?? '', NODE_ENV: 'production' },
    });

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += chunk.toString('utf8');
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.once('error', (error) => {
      clearTimeout(timer);
      reject(new ScannerError('The scanner could not be started.', error.message));
    });

    child.once('close', (code) => {
      clearTimeout(timer);

      if (timedOut) {
        reject(new ScannerError(`The scan exceeded its ${timeoutMs / 1000}s time limit.`));
        return;
      }
      // 0 is a clean scan; 1 means findings at or above the threshold, which
      // --fail-on never should prevent but is harmless either way.
      if (code === 0 || code === 1) {
        resolve();
        return;
      }
      reject(
        new ScannerError(
          `The scanner exited with code ${code ?? 'unknown'}.`,
          stderr.trim().slice(0, 500) || undefined,
        ),
      );
    });
  });
}

/**
 * Exported so the mapping can be tested against a real captured report rather
 * than only through a subprocess. Shape drift in the scanner is the thing most
 * likely to break this integration, and it is what these tests watch for.
 */
export function parseScannerOutput(raw: string): ScanResult {
  const parsed = reportSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    // A shape change in the scanner is a deployment problem, not a scan
    // failure, and should be loud rather than quietly producing zero findings.
    throw new ScannerError(
      'The scanner produced output in an unexpected shape.',
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    );
  }

  const result = parsed.data.results[0];
  if (result === undefined) {
    throw new ScannerError('The scanner returned no result for the target.');
  }

  const observations: ScanObservation[] = result.findings.map((finding) => ({
    findingKey: finding.id,
    checkId: finding.checkId,
    category: finding.category,
    severity: finding.severity,
    confidence: finding.confidence,
    title: finding.title,
    summary: finding.summary,
    remediation: finding.remediation,
    targetUrl: finding.target,
    evidence: finding.evidence,
  }));

  // Both matter for the same reason: neither produced a verdict, so issues
  // belonging to these checks must survive reconciliation untouched.
  const checksNotRun = [
    ...new Set([
      ...result.skippedChecks,
      ...result.checkErrors.map((error) => error.checkId),
    ]),
  ];

  const warnings = [
    ...result.collectorErrors.map(
      (error) => `Evidence "${error.collectorId}" was unavailable: ${error.message}`,
    ),
    ...result.checkErrors.map((error) => `Check "${error.checkId}" failed: ${error.message}`),
  ];

  return {
    scannerVersion: parsed.data.tool.version,
    observations,
    checksNotRun,
    requestCount: result.requestCount,
    warnings,
  };
}
