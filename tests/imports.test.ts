import { describe, expect, it } from 'vitest';
import {
  buildFileGraph,
  extractImports,
  resolveImport
} from '../src/scanner/imports';

describe('import extraction', () => {
  it('extracts static, dynamic, and require imports from TS/JS', () => {
    const imports = extractImports(
      'src/index.ts',
      [
        "import type { Config } from './config';",
        "import './side-effect';",
        "const lazy = import('./lazy');",
        "const common = require('./common');",
        "import external from 'package-name';",
        "// import './commented-out';",
        "/* require('./also-commented-out'); */"
      ].join('\n')
    );

    expect(imports).toEqual([
      './config',
      './side-effect',
      'package-name',
      './lazy',
      './common'
    ]);
  });

  it('extracts Python import and from-import statements', () => {
    const imports = extractImports(
      'python/app.py',
      [
        'import package.worker, package.other as other',
        'from . import helpers, models as model',
        'from ..shared import value'
      ].join('\n')
    );

    expect(imports).toEqual([
      'package.worker',
      'package.other',
      '.helpers',
      '.models',
      '..shared'
    ]);
  });
});

describe('relative import resolution', () => {
  const paths = new Set([
    'src/index.ts',
    'src/feature.ts',
    'src/folder/index.tsx',
    'python/app.py',
    'python/helpers.py',
    'shared.py',
    'package/worker.py'
  ]);

  it('resolves TS/JS files and directory indexes', () => {
    expect(resolveImport('src/index.ts', './feature', paths)).toBe('src/feature.ts');
    expect(resolveImport('src/index.ts', './folder', paths)).toBe('src/folder/index.tsx');
    expect(resolveImport('src/index.ts', 'three', paths)).toBeUndefined();
  });

  it('resolves relative and workspace-local Python modules', () => {
    expect(resolveImport('python/app.py', '.helpers', paths)).toBe('python/helpers.py');
    expect(resolveImport('python/app.py', '..shared', paths)).toBe('shared.py');
    expect(resolveImport('python/app.py', 'package.worker', paths)).toBe(
      'package/worker.py'
    );
  });
});

describe('file graph construction', () => {
  it('deduplicates resolved import edges and ignores external dependencies', () => {
    const graph = buildFileGraph([
      {
        path: 'src/a.ts',
        content: "import './b';\nconst again = require('./b');\nimport 'external';"
      },
      { path: 'src/b.ts', content: 'export const value = 1;' }
    ]);

    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toEqual([
      { from: 'src/a.ts', to: 'src/b.ts', kind: 'import' }
    ]);
  });
});
