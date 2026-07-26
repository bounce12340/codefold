import { describe, expect, it } from 'vitest';
import {
  aggregateFolderEdges,
  groupFilesByFolder,
  mapFilesToFolders,
  ROOT_FOLDER
} from '../src/graph/folders';
import type { GraphNode } from '../src/scanner/model';

function fileNode(id: string): GraphNode {
  return {
    id,
    kind: 'file',
    path: id,
    name: id.split('/').at(-1) ?? id,
    range: { startLine: 0, endLine: 0 },
    lang: id.endsWith('.py') ? 'py' : 'ts',
    state: 'idle',
    errorSources: [],
    editingAgents: [],
    annotation: { auto: null, manual: null },
    lastVerifiedAt: null
  };
}

describe('folder graph projection', () => {
  it('groups files by first path segment and puts root files in (root)', () => {
    const groups = groupFilesByFolder([
      fileNode('src/index.ts'),
      fileNode('src/nested/feature.ts'),
      fileNode('tools/build.py'),
      fileNode('vite.config.ts')
    ]);

    expect(groups.map((group) => [group.key, group.files.map((file) => file.id)]))
      .toEqual([
        [ROOT_FOLDER, ['vite.config.ts']],
        ['src', ['src/index.ts', 'src/nested/feature.ts']],
        ['tools', ['tools/build.py']]
      ]);
  });

  it('aggregates cross-folder imports by direction and preserves import direction', () => {
    const groups = groupFilesByFolder([
      fileNode('src/a.ts'),
      fileNode('src/b.ts'),
      fileNode('tools/a.ts'),
      fileNode('tools/b.ts')
    ]);
    const folderByFile = mapFilesToFolders(groups);

    expect(aggregateFolderEdges([
      { from: 'src/a.ts', to: 'tools/a.ts', kind: 'import' },
      { from: 'tools/b.ts', to: 'src/a.ts', kind: 'import' },
      { from: 'src/b.ts', to: 'tools/b.ts', kind: 'import' },
      { from: 'src/a.ts', to: 'src/b.ts', kind: 'import' }
    ], folderByFile)).toEqual([
      { from: 'folder:src', to: 'folder:tools', count: 2 },
      { from: 'folder:tools', to: 'folder:src', count: 1 }
    ]);
  });
});
