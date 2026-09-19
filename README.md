# Bailey

[![CI](https://github.com/sriharifortitude/bailey/actions/workflows/ci.yml/badge.svg)](https://github.com/sriharifortitude/bailey/actions/workflows/ci.yml)

Continuous web security posture monitoring for teams that look after many
sites — agencies, MSPs, platform teams. Register a site, prove you control it,
and Bailey scans it on a schedule and tells you **what changed**: what's new,
what's fixed, and above all what came back after being fixed.

Multi-tenant SaaS. Source-available under the
[Business Source License 1.1](LICENSE): free to read, run and modify for
non-production use; commercial use needs a licence until 2030, when it
converts to Apache 2.0.

---

## The problem

A scanner tells you what is wrong today. Nobody runs one weekly across thirty
client sites and diffs the output by hand. The actual failure mode is
**drift** — a site was clean in March, a deploy in June dropped the CSP, and
nobody notices until a pentest or an incident.

The product value is not the scan. It is the state machine around it:

```
              first seen            no longer detected
   (nothing) ───────────► open ───────────────────────► resolved
                            │                               │
                            │ risk accepted                 │ detected again
                            ▼                               ▼
                         accepted                       regressed
```

`regressed` is the state this exists to surface.

## What it does

- **Domain ownership verification** before any scan runs, by DNS TXT record
  or a well-known file. Re-checked periodically; a domain that changes hands
  stops being scanned.
- **Scheduled scans** (daily / weekly / manual) via [parapet-scan](https://github.com/sriharifortitude/parapet-scan),
  run as an isolated subprocess.
- **Issue lifecycle** with fingerprint-based identity across scans, so a
  finding's triage history survives rubric and wording changes.
- **Triage**: accept risk with a reason and an expiry, assign to a colleague,
  full event history per issue.
- **Teams**: owner / admin / member / viewer, invitations, last-owner
  protection.
- **GDPR**: personal data export, erasure that keeps the audit trail intact,
  per-organisation scan-history retention.
- Works with JavaScript disabled. Every form is a real form.

## Tenant isolation, and why it's proven rather than asserted

Multi-tenancy is where SaaS products leak customer data. Bailey enforces it
twice, and the second layer is the one that matters:

1. **Application guard.** `withOrganisation()` in `src/lib/db/tenant.ts` is
   the only way to reach tenant data. The client is not exported, and an
   ESLint rule rejects constructing one anywhere else.
2. **Postgres row-level security.** The app connects as a role that owns
   nothing, so every tenant table's policy is applied by the database.
   Context travels as transaction-local session variables read through
   `NULLIF`, so *forgetting* to set it yields no rows, not every row.
3. **Startup assertion.** `assertTenantIsolationActive()` refuses to boot if
   the app role is a superuser, owns a table, or a table exists without a
   policy. A deployment that pointed at the owning role would otherwise lose
   isolation silently.

`tests/integration/tenant-isolation.test.ts` deliberately bypasses the
application guard and issues the unscoped queries a careless change would
introduce. It was mutation-tested: with RLS enabled those queries return
0 rows; with it disabled, 2. The tests fail when the protection is removed,
which is the only thing that makes them worth anything.

## Some decisions worth knowing about

Each is recorded in [`docs/adr/`](docs/adr/) with what was rejected and why.

- **A failed scan resolves nothing.** A scan that timed out observed nothing;
  reconciling its empty result would close every issue on the site. Failures
  are recorded separately and never reconciled.
- **Only checks that ran can auto-resolve.** If the TLS handshake fails, TLS
  checks are skipped. Their issues are left alone, not resolved on evidence
  nobody gathered.
- **Sessions are opaque tokens, not JWTs.** 32 random bytes, stored as a
  SHA-256 hash. Revocation is immediate and a table dump yields nothing usable.
- **Redis holds three identifiers per job and no tenant data.** A queue is
  not a place to smuggle rows past row-level security.
- **The schedule lives in Postgres and is polled.** BullMQ repeatable jobs
  would be a second copy that drifts every time a frequency changes.
- **Qualitative severity, no CVSS** — inherited from parapet-scan, for the
  reasons in its rubric.

## Stack

Next.js 15 (App Router, server components and actions), TypeScript strict,
PostgreSQL 17 with row-level security, Prisma, Redis + BullMQ, Argon2id,
Vitest. No client-side framework code beyond what Next ships; no UI library.

## Running it

Requires Node 20.11+, Docker.

```bash
cp .env.example .env         # then set AUTH_SECRET (instructions inside)
npm ci
npm run db:up                # postgres + redis
npm run db:deploy            # migrations, including the RLS policies
npm run dev                  # http://localhost:3000
npm run worker               # in a second terminal: scans, scheduler, housekeeping
```

Sign up, add a site, follow the verification instructions it shows you, then
scan. `npm run db:studio` opens the database.

## Testing

```bash
npm test                     # 128 unit tests, no Docker needed
npm run test:integration     # 56 tests against real Postgres: isolation, sessions,
                             # the full open → resolve → regress cycle, job logic
```

The web routes are thin over the tested lib layer and are verified by strict
typecheck, lint (including jsx-a11y), and a production build rather than by
component tests. The signup flow was additionally driven end to end with curl
as a no-JavaScript browser would submit it. Playwright coverage of the critical
flows is the obvious next step and is not there yet.

## Limitations

- **No email delivery.** Invitation links are shown on screen. Wiring a
  provider is straightforward; choosing one is a deployment decision.
- **One organisation context per request.** Cross-organisation views (an
  agency dashboard across all its clients) are not built.
- **No rate limiting on login.** Argon2id makes each attempt expensive, and
  the dummy-hash path prevents enumeration, but a reverse proxy should still
  limit attempts per address before this faces the internet —
  [gatelimit](https://github.com/sriharifortitude/gatelimit) with an
  IP-keyed rule on `/login` is the intended one.
- **Retention prunes scan history only.** Issues and their events are kept
  indefinitely; per-organisation deletion is the mechanism for those.
- **UI is functional, not designed.** It is accessible, consistent and
  hand-styled; it is not a design system.

## Licence

[Business Source License 1.1](LICENSE). Change date 2030-09-07, change licence
Apache 2.0. Licensor: Sri Hari Manikandan.
