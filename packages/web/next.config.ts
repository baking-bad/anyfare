import path from 'node:path';

import type { NextConfig } from 'next';

// The workspace root: dependencies are hoisted there, and the standalone output traces from it
const root = path.join(import.meta.dirname, '../..');

// `npm run dev` reads the repo's .env, as the other apps do. Variables already set win. Deployments set
// their own environment.
if (process.env['NODE_ENV'] === 'development') {
  try {
    process.loadEnvFile(path.join(root, '.env'));
  }
  catch {
    // No .env: the defaults apply
  }
}

const config: NextConfig = {
  // TypeScript 7 has no JavaScript API for Next.js to check types with: `npm run typecheck` does (tsc 7)
  typescript: { ignoreBuildErrors: true },
  // The image runs the standalone server
  output: 'standalone',
  outputFileTracingRoot: root,
  turbopack: { root },
  // Tests build into their own directory, so a development build stays as it is
  distDir: process.env['NEXT_DIST_DIR'] ?? '.next',
  poweredByHeader: false,
  reactStrictMode: true,
  // Browsers ask for /favicon.ico on their own: it is the site's icon
  redirects: async () => [{ source: '/favicon.ico', destination: '/icon', permanent: false }],
};

export default config;
