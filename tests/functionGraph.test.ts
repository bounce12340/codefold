import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildFunctionGraph } from '../src/scanner/functions/functionGraph';
import type { FunctionGraph } from '../src/scanner/functions/functionGraph';
import type { SourceFile } from '../src/scanner/model';

const fixtureRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'function-workspace'
);

describe('tree-sitter function graph', () => {
  let graph: FunctionGraph;
  const diagnostics: string[] = [];

  beforeAll(async () => {
    const relativePaths = [
      'python/app.py',
      'python/helpers.py',
      'src/callee.ts',
      'src/caller.ts',
      'src/panel.tsx',
      'src/widget.jsx'
    ];
    const files: SourceFile[] = await Promise.all(relativePaths.map(async (filePath) => ({
      path: filePath,
      content: await readFile(path.join(fixtureRoot, ...filePath.split('/')), 'utf8')
    })));
    graph = await buildFunctionGraph(files, {
      onDiagnostic: (message) => diagnostics.push(message)
    });
  });

  it('extracts TypeScript functions, classes, methods, and ranges', () => {
    expect(
      graph.nodes
        .filter((node) => node.path === 'src/callee.ts')
        .map((node) => ({
          id: node.id,
          range: node.range
        }))
    ).toEqual([
      {
        id: 'src/callee.ts#formatName',
        range: { startLine: 0, endLine: 2 }
      },
      {
        id: 'src/callee.ts#Greeter',
        range: { startLine: 4, endLine: 8 }
      },
      {
        id: 'src/callee.ts#Greeter.greet',
        range: { startLine: 5, endLine: 7 }
      },
      {
        id: 'src/callee.ts#makeGreeting',
        range: { startLine: 10, endLine: 12 }
      }
    ]);
  });

  it('extracts Python functions and class methods under their file', () => {
    expect(
      graph.nodes
        .filter((node) => node.path === 'python/app.py')
        .map((node) => node.id)
    ).toEqual([
      'python/app.py#Formatter',
      'python/app.py#Formatter.format',
      'python/app.py#Formatter.format_twice',
      'python/app.py#render'
    ]);
    expect(graph.edges).toContainEqual({
      from: 'python/app.py',
      to: 'python/app.py#Formatter.format',
      kind: 'contains'
    });
  });

  it('uses the TSX and JSX grammars for component functions', () => {
    expect(
      graph.nodes
        .filter((node) => node.path === 'src/panel.tsx')
        .map((node) => node.id)
    ).toEqual(['src/panel.tsx#label', 'src/panel.tsx#Panel']);
    expect(
      graph.nodes
        .filter((node) => node.path === 'src/widget.jsx')
        .map((node) => node.id)
    ).toEqual(['src/widget.jsx#helper', 'src/widget.jsx#Widget']);
    expect(graph.edges).toContainEqual({
      from: 'src/widget.jsx#Widget',
      to: 'src/widget.jsx#helper',
      kind: 'call'
    });
  });

  it('creates same-file call edges', () => {
    expect(graph.edges).toContainEqual({
      from: 'src/callee.ts#Greeter.greet',
      to: 'src/callee.ts#formatName',
      kind: 'call'
    });
    expect(graph.edges).toContainEqual({
      from: 'python/app.py#Formatter.format_twice',
      to: 'python/app.py#Formatter.format',
      kind: 'call'
    });
  });

  it('creates cross-file call edges through TS and Python imports', () => {
    expect(graph.edges).toContainEqual({
      from: 'src/caller.ts#renderName',
      to: 'src/callee.ts#formatName',
      kind: 'call'
    });
    expect(graph.edges).toContainEqual({
      from: 'python/app.py#render',
      to: 'python/helpers.py#normalize',
      kind: 'call'
    });
    expect(diagnostics).toContainEqual(
      expect.stringContaining('unresolved or dynamic function call')
    );
  });
});
