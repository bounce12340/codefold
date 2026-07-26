import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readWorkspaceNotes,
  writeWorkspaceNote
} from '../src/scanner/notes';

describe('workspace notes', () => {
  let workspaceRoot = '';

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(path.join(tmpdir(), 'codefold-notes-'));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('writes, reads, and merges notes by relative path', async () => {
    await writeWorkspaceNote(workspaceRoot, 'src/index.ts', 'Entry point note.');
    await writeWorkspaceNote(workspaceRoot, 'python/app.py', 'Python note.');

    expect(await readWorkspaceNotes(workspaceRoot)).toEqual({
      'python/app.py': 'Python note.',
      'src/index.ts': 'Entry point note.'
    });
  });

  it('updates an existing note and removes it when saved empty', async () => {
    await writeWorkspaceNote(workspaceRoot, 'src/index.ts', 'First note.');
    await writeWorkspaceNote(workspaceRoot, 'src/index.ts', 'Updated note.');
    expect(await readWorkspaceNotes(workspaceRoot)).toEqual({
      'src/index.ts': 'Updated note.'
    });

    await writeWorkspaceNote(workspaceRoot, 'src/index.ts', '   ');
    expect(await readWorkspaceNotes(workspaceRoot)).toEqual({});
  });
});
