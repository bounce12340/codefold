import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanWorkspaceRoot } from '../src/scanner/scanWorkspace';

const sourceFixtureRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'sample-workspace'
);

describe('workspace scanning', () => {
  let fixtureRoot = '';

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), 'codefold-fixture-'));
    await cp(sourceFixtureRoot, fixtureRoot, { recursive: true });
    await mkdir(path.join(fixtureRoot, 'ignored'), { recursive: true });
    await writeFile(
      path.join(fixtureRoot, 'ignored', 'secret.ts'),
      'export const shouldNotBeScanned = true;\n'
    );
    await mkdir(path.join(fixtureRoot, 'node_modules', 'dependency'), {
      recursive: true
    });
    await writeFile(
      path.join(fixtureRoot, 'node_modules', 'dependency', 'index.js'),
      "module.exports = 'excluded';\n"
    );
    await mkdir(path.join(fixtureRoot, '.codefold'), { recursive: true });
    await writeFile(
      path.join(fixtureRoot, '.codefold', 'notes.json'),
      `${JSON.stringify({ 'src/index.ts': 'Pinned fixture entry point.' }, null, 2)}\n`
    );
  });

  afterAll(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it('finds supported files while honoring .gitignore and node_modules exclusion', async () => {
    const result = await scanWorkspaceRoot(fixtureRoot);
    const nodeIds = result.nodes.map((node) => node.id);

    expect(nodeIds).toEqual([
      'python/__init__.py',
      'python/app.py',
      'python/helpers.py',
      'src/feature.ts',
      'src/index.ts',
      'src/util.ts'
    ]);
    expect(nodeIds).not.toContain('ignored/secret.ts');
    expect(nodeIds.some((id) => id.includes('node_modules'))).toBe(false);
    expect(result.edges).toEqual([
      {
        from: 'python/app.py',
        to: 'python/helpers.py',
        kind: 'import'
      },
      {
        from: 'src/index.ts',
        to: 'src/feature.ts',
        kind: 'import'
      },
      {
        from: 'src/index.ts',
        to: 'src/util.ts',
        kind: 'import'
      },
      {
        from: 'src/util.ts',
        to: 'src/feature.ts',
        kind: 'import'
      }
    ]);
    expect(
      result.nodes.find((node) => node.id === 'src/index.ts')?.annotation
    ).toEqual({
      auto: 'Boots the TypeScript fixture.',
      manual: 'Pinned fixture entry point.'
    });
    expect(
      result.nodes.find((node) => node.id === 'python/app.py')?.annotation.auto
    ).toBe('Runs the Python fixture.');
    expect(
      result.nodes.find((node) => node.id === 'src/util.ts')?.annotation
    ).toEqual({ auto: null, manual: null });
  });

  it('returns a stable first-page truncation signal', async () => {
    const result = await scanWorkspaceRoot(fixtureRoot, { maxFiles: 2 });

    expect(result.truncated).toBe(true);
    expect(result.totalFiles).toBe(6);
    expect(result.nodes.map((node) => node.id)).toEqual([
      'python/__init__.py',
      'python/app.py'
    ]);
  });
});
