import { build } from 'esbuild';
import path from 'path';

(async () => {
  await build({
    bundle: true,
    entryPoints: [path.join(path.resolve(), 'build/index.js')],
    outfile: path.join(path.resolve(), 'dist/index.js'),
    logLevel: 'silent',
    sourcemap: false,
    target: 'esnext',
    format: 'cjs',
    platform: 'node',
    minify: false,
  });
})();
