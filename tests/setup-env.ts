import { existsSync } from 'node:fs';

// Node loads .env for `next dev` but not for vitest. Loaded here rather than
// via a dependency so the test environment matches the runtime one exactly.
if (existsSync('.env')) process.loadEnvFile('.env');
// Vitest already sets NODE_ENV to 'test' itself, as a non-configurable
// property -- redefining it here would throw at runtime, so this file only
// loads .env and leaves NODE_ENV alone.
