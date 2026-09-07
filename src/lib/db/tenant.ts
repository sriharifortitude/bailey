import { PrismaClient, type Prisma } from '@prisma/client';

import { env } from '@/lib/env';

/**
 * All tenant data access goes through this module.
 *
 * The restricted client is deliberately not exported. Code that wants to read
 * or write tenant-owned rows has to go through withOrganisation(), which opens
 * a transaction and sets the organisation context on that connection before
 * running the callback. Row-level security then filters every statement inside
 * it, so a query that forgets a where clause returns nothing rather than
 * returning another customer's rows.
 *
 * Two layers, on purpose:
 *   - this module makes the correct thing the only convenient thing
 *   - the database makes the incorrect thing return no data anyway
 *
 * tests/integration/tenant-isolation.test.ts asserts the second layer holds
 * with the first one deliberately bypassed.
 */

const restricted = new PrismaClient({ datasourceUrl: env.APP_DATABASE_URL });

/** Owner connection. Migrations, retention jobs, and the erasure worker only. */
export const administrativeDb = new PrismaClient({ datasourceUrl: env.DATABASE_URL });

/** The subset of the client available inside a scoped transaction. */
export type TenantClient = Omit<PrismaClient, ITXClientDenyList>;
type ITXClientDenyList = '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends';

export interface RequestContext {
  readonly userId: string;
  readonly organisationId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * set_config is called with parameters rather than interpolation, but the
 * values are validated as UUIDs first. The session variable ends up inside a
 * policy expression, and an unvalidated value there is worth being paranoid
 * about even when the driver is parameterising correctly.
 */
function assertUuid(value: string, label: string): void {
  if (!UUID.test(value)) throw new TypeError(`${label} is not a UUID: ${value}`);
}

/**
 * Runs `fn` with both the user and organisation context set, inside one
 * transaction. Everything the callback does is filtered by the organisation's
 * row-level security policies.
 */
export async function withOrganisation<T>(
  context: RequestContext,
  fn: (db: TenantClient) => Promise<T>,
  options: { readonly timeoutMs?: number } = {},
): Promise<T> {
  assertUuid(context.userId, 'userId');
  assertUuid(context.organisationId, 'organisationId');

  return restricted.$transaction(
    async (tx) => {
      // Local to the transaction, so the context cannot leak to the next
      // request that borrows this pooled connection.
      await tx.$executeRaw`SELECT set_config('app.current_user_id', ${context.userId}, true)`;
      await tx.$executeRaw`SELECT set_config('app.current_organisation', ${context.organisationId}, true)`;
      return fn(tx);
    },
    { timeout: options.timeoutMs ?? 15_000 },
  );
}

/**
 * For the window after authentication but before an organisation is chosen:
 * only the user context is set, so the memberships policy is the sole thing
 * readable. Used to answer "which organisations may this session select?".
 */
export async function withUser<T>(
  userId: string,
  fn: (db: TenantClient) => Promise<T>,
): Promise<T> {
  assertUuid(userId, 'userId');

  return restricted.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_user_id', ${userId}, true)`;
    return fn(tx);
  });
}

/**
 * Tables outside the tenancy model: users and sessions. Reachable only by a
 * primary key or a token hash the caller already holds. Kept as a named,
 * greppable function so "what runs without an organisation scope?" has a
 * single answer.
 */
export async function withoutTenantScope<T>(fn: (db: TenantClient) => Promise<T>): Promise<T> {
  return restricted.$transaction(async (tx) => fn(tx));
}

/**
 * Verifies at startup that the isolation the design depends on is actually in
 * force. A deployment that points APP_DATABASE_URL at the owning role would
 * silently lose row-level security -- every query would still succeed, and the
 * only symptom would be one customer seeing another's data.
 *
 * This is the check that turns that from a silent data breach into a failure
 * to boot.
 */
export async function assertTenantIsolationActive(): Promise<void> {
  const [identity] = await restricted.$queryRaw<
    Array<{ current_user: string; is_superuser: boolean }>
  >`SELECT current_user, (SELECT usesuper FROM pg_user WHERE usename = current_user) AS is_superuser`;

  if (identity === undefined) {
    throw new Error('Could not determine the identity of the application database connection.');
  }
  if (identity.is_superuser) {
    throw new Error(
      `The application connects as superuser "${identity.current_user}", which bypasses row-level security. ` +
        'Point APP_DATABASE_URL at the restricted role.',
    );
  }

  const owners = await restricted.$queryRaw<Array<{ tablename: string; tableowner: string }>>`
    SELECT tablename, tableowner FROM pg_tables
    WHERE schemaname = 'public' AND tableowner = current_user
  `;
  if (owners.length > 0) {
    throw new Error(
      `The application role owns ${owners.length} table(s) and therefore bypasses row-level security. ` +
        'Point APP_DATABASE_URL at a role that owns nothing.',
    );
  }

  const unprotected = await restricted.$queryRaw<Array<{ relname: string }>>`
    SELECT c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relrowsecurity = false
      AND c.relname NOT IN ('users', 'sessions', '_prisma_migrations')
  `;
  if (unprotected.length > 0) {
    throw new Error(
      'Row-level security is not enabled on: ' +
        unprotected.map((row) => row.relname).join(', ') +
        '. Either add a policy or add the table to the documented exception list.',
    );
  }
}

export async function disconnect(): Promise<void> {
  await Promise.all([restricted.$disconnect(), administrativeDb.$disconnect()]);
}

/**
 * Escape hatch for the isolation tests only: an unscoped handle to the
 * restricted client, so a test can prove that row-level security blocks a
 * query the application guard would never have issued. Not exported from the
 * package entry point and never used by application code.
 */
export const __unsafeRestrictedClientForTests: PrismaClient = restricted;

export type { Prisma };
