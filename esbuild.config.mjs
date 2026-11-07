import { chmodSync } from 'node:fs';
import { build } from 'esbuild';

await build({
  entryPoints: ['src/cli.ts'],
  outdir: 'dist',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
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
