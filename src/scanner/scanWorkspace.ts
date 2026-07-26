import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { globby } from 'globby';
import { buildFileGraph } from './imports';
import { buildFunctionGraph } from './functions/functionGraph';
import type { FileGraph, GraphEdge, GraphNode, SourceFile } from './model';
import { readWorkspaceNotes, type WorkspaceNotes } from './notes';

const SOURCE_GLOBS = ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.py'];

export interface ScanResult extends FileGraph {
  truncated: boolean;
  totalFiles: number;
  functionNodes: GraphNode[];
  functionEdges: GraphEdge[];
  unresolvedCalls: number;
  sourceContents: Record<string, string>;
}

export interface ScanOptions {
  maxFiles?: number;
  onError?: (message: string) => void;
  includeFunctions?: boolean;
  wasmDirectory?: string;
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
  const functionGraph = options.includeFunctions === false
    ? { nodes: [], edges: [], unresolvedCalls: 0 }
    : await buildFunctionGraph(files, {
      wasmDirectory: options.wasmDirectory,
      onDiagnostic: onError
    });
  return {
    ...graph,
    truncated: relativePaths.length > maxFiles,
    totalFiles: relativePaths.length,
    functionNodes: functionGraph.nodes,
    functionEdges: functionGraph.edges,
    unresolvedCalls: functionGraph.unresolvedCalls,
    sourceContents: Object.fromEntries(files.map((file) => [file.path, file.content]))
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
