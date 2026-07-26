import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readWorkspaceLayout,
  writeWorkspaceLayout
} from '../src/layout/workspaceLayout';

describe('workspace layout persistence', () => {
  let workspaceRoot = '';

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(path.join(tmpdir(), 'codefold-layout-'));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('reads, writes, and merges group and relative file positions', async () => {
    await writeWorkspaceLayout(workspaceRoot, {
      groups: {
        'folder:src': { x: 120, y: -40, expanded: true }
      }
    });
    await writeWorkspaceLayout(workspaceRoot, {
      groups: {
        'folder:tools': { x: 450, y: 80, expanded: false }
      },
      files: {
        'src/index.ts': { x: 24, y: 64 }
      }
    });

    expect(await readWorkspaceLayout(workspaceRoot)).toEqual({
      version: 1,
      groups: {
        'folder:src': { x: 120, y: -40, expanded: true },
        'folder:tools': { x: 450, y: 80, expanded: false }
      },
      files: {
        'src/index.ts': { x: 24, y: 64 }
      }
    });
  });

  it('rejects a malformed layout instead of silently replacing it', async () => {
    await mkdir(path.join(workspaceRoot, '.codefold'), { recursive: true });
    await writeFile(
      path.join(workspaceRoot, '.codefold', 'layout.json'),
      '{"version":1,"groups":[],"files":{}}\n'
    );

    await expect(readWorkspaceLayout(workspaceRoot)).rejects.toThrow(
      'must contain groups and files objects'
    );
  });

  it('serializes concurrent merges so neither update is lost', async () => {
    await Promise.all([
      writeWorkspaceLayout(workspaceRoot, {
        groups: {
          'folder:src': { x: 10, y: 20, expanded: true }
        }
      }),
      writeWorkspaceLayout(workspaceRoot, {
        groups: {
          'folder:tools': { x: 30, y: 40, expanded: false }
        }
      })
    ]);

    expect((await readWorkspaceLayout(workspaceRoot)).groups).toEqual({
      'folder:src': { x: 10, y: 20, expanded: true },
      'folder:tools': { x: 30, y: 40, expanded: false }
    });
  });
});
