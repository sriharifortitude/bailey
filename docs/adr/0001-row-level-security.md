# 0001. Postgres row-level security as the isolation backstop

**Status:** accepted

## Context

Every tenant table carries `organisationId`, and the obvious design is to
add `where: { organisationId }` to every query. It works until the twentieth
query is written in a hurry without it, and that mistake is a data breach
that produces no error, no log line and no failing test.

## Decision

Two layers. `withOrganisation()` sets two transaction-local Postgres session
variables and is the only exported way to reach tenant data. Every tenant
table has a row-level security policy written against those variables. The
application connects as a role that owns nothing, so Postgres applies the
policies to it; migrations run as the owner and are not subject to them.

The variables are read with `missing_ok` and passed through `NULLIF`, so an
unset context yields NULL, and a comparison against NULL is never true. The
failure mode of forgetting is "no rows", not "every row".

`assertTenantIsolationActive()` runs at startup and refuses to boot if the
app role is a superuser, owns a table, or any table lacks a policy.

## Reasoning

The first layer makes the correct thing the only convenient thing. The
second makes the incorrect thing return nothing anyway. The isolation test
suite bypasses the first layer on purpose and issues exactly the unscoped
queries a careless change would introduce; it was mutation-tested by
disabling RLS and watching it fail.

## Costs

- Two session variables per transaction, set with two round trips.
- Three lookups need the owner connection because the organisation context
  is the thing being looked up: slug to id, invitation token to organisation,
  and a user's own organisation list. Each is documented at the call site.
- A table added without a policy fails at boot, not at review. That is the
  point, but it is a sharp edge for someone adding their first table.

## Rejected

**Prisma middleware injecting the where clause.** Application-layer only; a
raw query or a future ORM change bypasses it.

**Schema-per-tenant.** Correct isolation, but migrations become O(tenants)
and connection pooling gets harder; not warranted at this scale.
