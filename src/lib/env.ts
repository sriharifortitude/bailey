import { z } from 'zod';

/**
 * Environment is validated once, at import, and the process refuses to start if
 * anything is missing or malformed. A server that boots with a half-configured
 * database URL fails later, somewhere less obvious, and usually in production.
 */
const schema = z.object({
  // Owner connection. Runs migrations and administrative jobs, and is not
  // subject to row-level security.
  DATABASE_URL: z.string().url(),

  // Restricted connection used to serve requests. Must be a different role
  // from DATABASE_URL or row-level security has nothing to act on; this is
  // checked at runtime by assertTenantIsolationActive().
  APP_DATABASE_URL: z.string().url(),

  REDIS_URL: z.string().url(),

  // 32 bytes minimum once decoded. Used to derive CSRF tokens; session tokens are opaque random values validated by database lookup and need no signature.
  AUTH_SECRET: z
    .string()
    .min(1, 'AUTH_SECRET is required')
    .refine((value) => Buffer.from(value, 'base64').length >= 32, {
      message: 'AUTH_SECRET must decode to at least 32 bytes',
    }),

  APP_ORIGIN: z.string().url(),

  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}

export const env = load();
