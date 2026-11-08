import { chmodSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

// Start from an empty dist: chunk names carry content hashes, so a stale build would otherwise ship in the package.
rmSync('dist', { recursive: true, force: true });

await build({
  entryPoints: ['src/cli.ts'],
  outdir: 'dist',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  // Prefer the SDK's ESM builds: with the Node default (main first) the AWS SDK is bundled from CommonJS,
  // and a dynamic import() of a CommonJS module only exposes `default`, so `EC2Client` came back undefined.
  mainFields: ['module', 'main'],
  target: 'node22',
  outExtension: { '.js': '.mjs' },
  sourcemap: false,
  minify: false,
  logLevel: 'info',
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});
chmodSync('dist/cli.mjs', 0o755);
