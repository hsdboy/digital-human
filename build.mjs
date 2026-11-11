import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'esm',
  target: 'es2020',
  outfile: 'bundle.js',
  minify: false,
  sourcemap: false,
  logLevel: 'info',
});
