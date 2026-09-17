import type { NextConfig } from 'next';

const config: NextConfig = {
  // Stack traces from a scanned site's own HTML must never render as our
  // markup; React escapes by default and nothing here disables that.
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: false },
  typescript: { ignoreBuildErrors: false },

  // bullmq optionally requires @valkey/valkey-glide, an alternative Redis
  // client this project does not install -- it falls back to ioredis, which
  // is installed. Left to webpack, that optional require is a bundling
  // failure it cannot see is harmless; excluding both packages from the
  // server bundle means Node's own `require` resolves them at runtime
  // instead, exactly as bullmq expects.
  serverExternalPackages: ['bullmq', 'ioredis'],
};

export default config;
