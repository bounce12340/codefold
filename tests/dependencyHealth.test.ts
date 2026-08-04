import { describe, expect, it } from 'vitest';
import { analyzeDependencyHealth, edgeKey } from '../src/graph/dependencyHealth';
import type { GraphEdge, GraphNode } from '../src/scanner/model';

describe('dependency health', () => {
  it('reports a two-file import cycle and the edges that close it', () => {
    const health = analyzeDependencyHealth(
      files(['src/a.ts', 'src/b.ts', 'src/c.ts']),
      [
        importEdge('src/a.ts', 'src/b.ts'),
        importEdge('src/b.ts', 'src/a.ts'),
        importEdge('src/a.ts', 'src/c.ts')
      ]
    );

    expect(health.cycles).toEqual([
      { id: 'cycle:src/a.ts|src/b.ts', nodeIds: ['src/a.ts', 'src/b.ts'] }
    ]);
    expect(health.cyclicNodeIds).toEqual(['src/a.ts', 'src/b.ts']);
    expect(health.cyclicEdgeKeys).toEqual([
      edgeKey('src/a.ts', 'src/b.ts'),
      edgeKey('src/b.ts', 'src/a.ts')
    ]);
    // a -> c is a one-way dependency and must not be dragged into the cycle.
    expect(health.cyclicEdgeKeys).not.toContain(edgeKey('src/a.ts', 'src/c.ts'));
  });

  it('finds a longer cycle and keeps acyclic files out of it', () => {
    const health = analyzeDependencyHealth(
      files(['a.ts', 'b.ts', 'c.ts', 'd.ts']),
      [
        importEdge('a.ts', 'b.ts'),
        importEdge('b.ts', 'c.ts'),
        importEdge('c.ts', 'a.ts'),
        importEdge('c.ts', 'd.ts')
      ]
    );

    expect(health.cycles).toHaveLength(1);
    expect(health.cycles[0].nodeIds).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(health.cyclicNodeIds).not.toContain('d.ts');
  });

  it('separates two independent cycles instead of merging them', () => {
    const health = analyzeDependencyHealth(
      files(['a.ts', 'b.ts', 'x.ts', 'y.ts', 'bridge.ts']),
      [
        importEdge('a.ts', 'b.ts'),
        importEdge('b.ts', 'a.ts'),
        importEdge('x.ts', 'y.ts'),
        importEdge('y.ts', 'x.ts'),
        importEdge('b.ts', 'bridge.ts'),
        importEdge('bridge.ts', 'x.ts')
      ]
    );

    expect(health.cycles.map((cycle) => cycle.nodeIds)).toEqual([
      ['a.ts', 'b.ts'],
      ['x.ts', 'y.ts']
    ]);
    expect(health.cyclicNodeIds).not.toContain('bridge.ts');
  });

  it('ignores call edges so recursion is never reported as a cycle', () => {
    const nodes: GraphNode[] = [
      ...files(['src/a.ts']),
      { ...file('src/a.ts#walk'), kind: 'function' },
      { ...file('src/a.ts#step'), kind: 'function' }
    ];
    const health = analyzeDependencyHealth(nodes, [
      { from: 'src/a.ts#walk', to: 'src/a.ts#step', kind: 'call' },
      { from: 'src/a.ts#step', to: 'src/a.ts#walk', kind: 'call' },
      { from: 'src/a.ts', to: 'src/a.ts#walk', kind: 'contains' }
    ]);

    expect(health.cycles).toEqual([]);
    expect(health.cyclicNodeIds).toEqual([]);
  });

  it('reports fan-in and fan-out, counting a duplicated import once', () => {
    const health = analyzeDependencyHealth(
      files(['hub.ts', 'one.ts', 'two.ts']),
      [
        importEdge('one.ts', 'hub.ts'),
        importEdge('one.ts', 'hub.ts'),
        importEdge('two.ts', 'hub.ts'),
        importEdge('hub.ts', 'one.ts')
      ]
    );

    expect(health.coupling).toEqual([
      { nodeId: 'hub.ts', fanIn: 2, fanOut: 1 },
      { nodeId: 'one.ts', fanIn: 1, fanOut: 1 },
      { nodeId: 'two.ts', fanIn: 0, fanOut: 1 }
    ]);
  });

  it('drops edges pointing outside the scanned graph', () => {
    const health = analyzeDependencyHealth(files(['a.ts']), [
      importEdge('a.ts', 'node_modules/dep/index.js'),
      importEdge('a.ts', 'a.ts')
    ]);

    expect(health.cycles).toEqual([]);
    expect(health.coupling).toEqual([]);
  });

  it('collapses a cross-folder cycle onto the folders that close it', () => {
    const health = analyzeDependencyHealth(
      files(['src/ui/canvas.ts', 'lib/graph/edges.ts', 'src/index.ts']),
      [
        importEdge('src/ui/canvas.ts', 'lib/graph/edges.ts'),
        importEdge('lib/graph/edges.ts', 'src/ui/canvas.ts'),
        importEdge('src/index.ts', 'src/ui/canvas.ts')
      ]
    );

    expect(health.folderCycles).toEqual([
      { id: 'cycle:folder:lib|folder:src', nodeIds: ['folder:lib', 'folder:src'] }
    ]);
    expect(health.cyclicFolderIds).toEqual(['folder:lib', 'folder:src']);
    expect(health.cyclicFolderEdgeKeys).toEqual([
      edgeKey('folder:lib', 'folder:src'),
      edgeKey('folder:src', 'folder:lib')
    ]);
  });

  it('does not report a folder cycle for a cycle contained in one folder', () => {
    const health = analyzeDependencyHealth(
      files(['src/a.ts', 'src/b.ts']),
      [importEdge('src/a.ts', 'src/b.ts'), importEdge('src/b.ts', 'src/a.ts')]
    );

    // The file-level cycle is real; collapsing it would make folder:src look
    // like it depends on itself, which says nothing about module boundaries.
    expect(health.cycles).toHaveLength(1);
    expect(health.folderCycles).toEqual([]);
    expect(health.cyclicFolderIds).toEqual([]);
  });

  it('reports a folder cycle even when no single file pair is cyclic', () => {
    const health = analyzeDependencyHealth(
      files(['src/a.ts', 'src/b.ts', 'lib/x.ts']),
      [
        importEdge('src/a.ts', 'lib/x.ts'),
        importEdge('lib/x.ts', 'src/b.ts')
      ]
    );

    // No file imports itself back, but src and lib depend on each other — the
    // boundary violation only exists at the folder level.
    expect(health.cycles).toEqual([]);
    expect(health.folderCycles.map((cycle) => cycle.nodeIds)).toEqual([
      ['folder:lib', 'folder:src']
    ]);
  });

  it('groups top-level files under the root folder', () => {
    const health = analyzeDependencyHealth(
      files(['index.ts', 'lib/x.ts']),
      [importEdge('index.ts', 'lib/x.ts'), importEdge('lib/x.ts', 'index.ts')]
    );

    expect(health.folderCycles[0].nodeIds).toEqual(['folder:(root)', 'folder:lib']);
  });

  it('handles a MAX_FILES-deep chain without exhausting the stack', () => {
    const ids = Array.from({ length: 2_000 }, (_, index) =>
      `src/file-${String(index).padStart(4, '0')}.ts`);
    const edges = ids.slice(0, -1).map((id, index) => importEdge(id, ids[index + 1]));
    // Close the chain so the whole workspace is one strongly connected
    // component — the deepest walk Tarjan can be asked to do here.
    edges.push(importEdge(ids[ids.length - 1], ids[0]));

    const health = analyzeDependencyHealth(files(ids), edges);

    expect(health.cycles).toHaveLength(1);
    expect(health.cycles[0].nodeIds).toHaveLength(2_000);
    expect(health.cyclicNodeIds).toHaveLength(2_000);
  });
});

function files(paths: readonly string[]): GraphNode[] {
  return paths.map((path) => file(path));
}

function file(id: string): GraphNode {
  return {
    id,
    kind: 'file',
    path: id.split('#')[0],
    name: id.split('/').at(-1) ?? id,
    range: { startLine: 0, endLine: 0 },
    lang: 'ts',
    state: 'idle',
    errorSources: [],
    editingAgents: [],
    annotation: { auto: null, manual: null },
    lastVerifiedAt: null
  };
}

function importEdge(from: string, to: string): GraphEdge {
  return { from, to, kind: 'import' };
}
