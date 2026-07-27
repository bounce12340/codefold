import * as esbuild from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { buildPreviewHarness } from './tools/preview/build.mjs';

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

async function copyTreeSitterWasm() {
  const outputDirectory = path.resolve('dist', 'tree-sitter');
  await mkdir(outputDirectory, { recursive: true });
  const assets = [
    ['node_modules/web-tree-sitter/web-tree-sitter.wasm', 'web-tree-sitter.wasm'],
    [
      'node_modules/tree-sitter-typescript/tree-sitter-typescript.wasm',
      'typescript.wasm'
    ],
    ['node_modules/tree-sitter-typescript/tree-sitter-tsx.wasm', 'tsx.wasm'],
    [
      'node_modules/tree-sitter-javascript/tree-sitter-javascript.wasm',
      'javascript.wasm'
    ],
    ['node_modules/tree-sitter-python/tree-sitter-python.wasm', 'python.wasm']
  ];
  await Promise.all(assets.map(([source, target]) =>
    copyFile(path.resolve(source), path.join(outputDirectory, target))
  ));
}

if (watch) {
  await Promise.all([copyTreeSitterWasm(), buildPreviewHarness()]);
  const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
  await Promise.all(contexts.map((context) => context.watch()));
  console.log('CodeFold bundles are being watched.');
} else {
  await Promise.all([
    ...builds.map((options) => esbuild.build(options)),
    copyTreeSitterWasm(),
    buildPreviewHarness()
  ]);
}
