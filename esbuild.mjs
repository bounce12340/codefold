import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const shared = {
  bundle: true,
  sourcemap: true,
  minify: false,
  logLevel: 'info',
};

const builds = [
  {
    ...shared,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  },
  {
    ...shared,
    entryPoints: ['src/webview/main.ts'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
  },
  {
    ...shared,
    entryPoints: ['src/webview2d/main.ts'],
    outfile: 'dist/webview2d.js',
    platform: 'browser',
    format: 'iife',
  },
];

if (watch) {
  const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
  await Promise.all(contexts.map((context) => context.watch()));
  console.log('CodeFold bundles are being watched.');
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
