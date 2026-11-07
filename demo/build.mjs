// Bundles demo/harness.ts the same way esbuild.config.mjs bundles the CLI. The output is git-ignored.
import { build } from 'esbuild';

await build({
  entryPoints: ['demo/harness.ts'],
  outfile: 'demo/build/demo.mjs',
  bundle: true,
  format: 'esm',
  platform: 'node',
  mainFields: ['module', 'main'],
  target: 'node22',
  logLevel: 'warning',
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});
