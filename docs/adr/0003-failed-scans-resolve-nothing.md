# 0003. A failed or partial scan never resolves an issue

**Status:** accepted

## Context

Reconciliation compares a scan's observations against the site's open
issues. An issue that stops being observed is resolved. That rule has a
catastrophic edge: a scan that observed *nothing* -- because the origin was
down, the scanner timed out, or a collector failed -- would resolve every
issue on the site.

## Decision

Two rules. A scan that did not complete is recorded as failed by a separate
code path (`recordScanFailure`) that never calls the reconciler. Within a
scan that did complete, checks the scanner reports as skipped or errored are
treated as "no verdict": issues belonging to those checks are left untouched
and surfaced as not-evaluated rather than resolved.

## Reasoning

A monitoring product's worst failure is a false all-clear. A network blip
that silently closes forty issues, followed by forty "regressed" events on
the next successful scan, teaches users to ignore the product. Both cases
are tested: a failed scan leaves every issue open; a scan with
`headers/hsts` skipped leaves the HSTS issue open while still resolving a
genuinely fixed CSP issue in the same run.

## Costs

A site whose TLS collector fails persistently accumulates stale TLS issues
that are never re-evaluated. That is visible (the scan run records the
warning) and correct: the alternative is guessing.
