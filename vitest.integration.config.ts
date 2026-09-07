import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Integration tests run against the real Postgres in docker-compose. They are
 * a separate project so `npm test` stays runnable without Docker, and they do
 * not run in parallel because they share one database.
 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    name: 'integration',
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup-env.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
