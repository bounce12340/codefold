import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { globby } from 'globby';
import { buildFileGraph } from './imports';
import type { FileGraph, SourceFile } from './model';
import { readWorkspaceNotes, type WorkspaceNotes } from './notes';

const SOURCE_GLOBS = ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.py'];

export interface ScanResult extends FileGraph {
  truncated: boolean;
  totalFiles: number;
}

export interface ScanOptions {
  maxFiles?: number;
  onError?: (message: string) => void;
}

export async function scanWorkspaceRoot(
  rootPath: string,
  options: ScanOptions = {}
): Promise<ScanResult> {
  const maxFiles = options.maxFiles ?? 2_000;
  const onError = options.onError ?? ((message: string) => console.error(message));
  const matches = await globby(SOURCE_GLOBS, {
    cwd: rootPath,
    gitignore: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    dot: false,
    ignore: ['**/node_modules/**']
  });
  const relativePaths = matches
    .map((filePath) => filePath.replaceAll('\\', '/'))
    .sort((left, right) => left.localeCompare(right));
  const selectedPaths = relativePaths.slice(0, maxFiles);
  const files: SourceFile[] = [];
  let manualAnnotations: WorkspaceNotes = {};

  try {
    manualAnnotations = await readWorkspaceNotes(rootPath);
  } catch (error) {
    onError(`Could not load CodeFold notes: ${formatError(error)}`);
  }

  for (const relativePath of selectedPaths) {
    try {
      const absolutePath = path.join(rootPath, ...relativePath.split('/'));
      files.push({
        path: relativePath,
        content: await readFile(absolutePath, 'utf8')
      });
    } catch (error) {
      onError(`Could not read ${relativePath}: ${formatError(error)}`);
    }
  }

  const graph = buildFileGraph(files, onError, manualAnnotations);
  return {
    ...graph,
    truncated: relativePaths.length > maxFiles,
    totalFiles: relativePaths.length
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
