import { existsSync } from 'node:fs';

// Node loads .env for `next dev` but not for vitest. Loaded here rather than
// via a dependency so the test environment matches the runtime one exactly.
if (existsSync('.env')) process.loadEnvFile('.env');
process.env['NODE_ENV'] = 'test';
