import path from 'node:path';
import type {
  FileGraph,
  GraphEdge,
  GraphNode,
  SourceFile,
  SupportedLanguage
} from './model';
import { extractFileAnnotation } from './annotations';
import type { WorkspaceNotes } from './notes';

const TYPESCRIPT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];
const SOURCE_EXTENSIONS = [...TYPESCRIPT_EXTENSIONS, '.py'];

export function languageForPath(filePath: string): SupportedLanguage | undefined {
  const extension = path.posix.extname(normalizePath(filePath)).toLowerCase();
  if (extension === '.ts' || extension === '.tsx') {
    return 'ts';
  }
  if (extension === '.js' || extension === '.jsx') {
    return 'js';
  }
  if (extension === '.py') {
    return 'py';
  }
  return undefined;
}

export function extractImports(
  filePath: string,
  source: string
): string[] {
  const language = languageForPath(filePath);
  if (language === 'py') {
    return extractPythonImports(source);
  }
  if (language === 'ts' || language === 'js') {
    return extractJavaScriptImports(source);
  }
  return [];
}

export function resolveImport(
  importerPath: string,
  specifier: string,
  availablePaths: ReadonlySet<string>
): string | undefined {
  const language = languageForPath(importerPath);
  if (language === 'py') {
    return resolvePythonImport(importerPath, specifier, availablePaths);
  }
  if ((language === 'ts' || language === 'js') && specifier.startsWith('.')) {
    const basePath = path.posix.normalize(
      path.posix.join(path.posix.dirname(normalizePath(importerPath)), specifier)
    );
    return findSourceCandidate(basePath, availablePaths, TYPESCRIPT_EXTENSIONS);
  }
  return undefined;
}

export function buildFileGraph(
  files: readonly SourceFile[],
  onError: (message: string) => void = (message) => console.error(message),
  manualAnnotations: Readonly<WorkspaceNotes> = {}
): FileGraph {
  const normalizedFiles = files
    .map((file) => ({ ...file, path: normalizePath(file.path) }))
    .filter((file) => languageForPath(file.path) !== undefined)
    .sort((left, right) => left.path.localeCompare(right.path));
  const availablePaths = new Set(normalizedFiles.map((file) => file.path));
  const nodes: GraphNode[] = normalizedFiles.map((file) => {
    const language = languageForPath(file.path);
    if (language === undefined) {
      throw new Error(`Unsupported source file reached graph builder: ${file.path}`);
    }
    return {
      id: file.path,
      kind: 'file',
      path: file.path,
      name: path.posix.basename(file.path),
      range: { startLine: 0, endLine: Math.max(0, countLines(file.content) - 1) },
      lang: language,
      state: 'idle',
      errorSources: [],
      editingAgents: [],
      annotation: {
        auto: extractFileAnnotation(file.path, file.content),
        manual: manualAnnotations[file.path] ?? null
      },
      lastVerifiedAt: null
    };
  });
  const edges: GraphEdge[] = [];
  const seenEdges = new Set<string>();

  for (const file of normalizedFiles) {
    try {
      for (const specifier of extractImports(file.path, file.content)) {
        const target = resolveImport(file.path, specifier, availablePaths);
        if (target === undefined || target === file.path) {
          continue;
        }
        const key = `${file.path}\0${target}`;
        if (!seenEdges.has(key)) {
          seenEdges.add(key);
          edges.push({ from: file.path, to: target, kind: 'import' });
        }
      }
    } catch (error) {
      onError(`Could not parse imports in ${file.path}: ${formatError(error)}`);
    }
  }

  edges.sort((left, right) =>
    `${left.from}\0${left.to}`.localeCompare(`${right.from}\0${right.to}`)
  );
  return { nodes, edges };
}

function extractJavaScriptImports(source: string): string[] {
  const imports = new Set<string>();
  const sourceWithoutCommentBlocks = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ];

  for (const pattern of patterns) {
    for (const match of sourceWithoutCommentBlocks.matchAll(pattern)) {
      if (match[1] !== undefined) {
        imports.add(match[1]);
      }
    }
  }
  return [...imports];
}

function extractPythonImports(source: string): string[] {
  const imports = new Set<string>();
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '');
    const directImport = /^\s*import\s+(.+?)\s*$/.exec(line);
    if (directImport?.[1] !== undefined) {
      for (const entry of directImport[1].split(',')) {
        const moduleName = entry.trim().split(/\s+as\s+/)[0];
        if (moduleName) {
          imports.add(moduleName);
        }
      }
      continue;
    }

    const fromImport = /^\s*from\s+([.\w]+)\s+import\s+(.+?)\s*$/.exec(line);
    if (fromImport?.[1] === undefined || fromImport[2] === undefined) {
      continue;
    }
    const moduleName = fromImport[1];
    if (/^\.+$/.test(moduleName)) {
      for (const entry of fromImport[2].replace(/[()]/g, '').split(',')) {
        const importedName = entry.trim().split(/\s+as\s+/)[0];
        if (importedName && importedName !== '*') {
          imports.add(`${moduleName}${importedName}`);
        }
      }
    } else {
      imports.add(moduleName);
    }
  }
  return [...imports];
}

function resolvePythonImport(
  importerPath: string,
  specifier: string,
  availablePaths: ReadonlySet<string>
): string | undefined {
  const normalizedImporter = normalizePath(importerPath);
  const leadingDots = specifier.match(/^\.+/)?.[0].length ?? 0;
  const moduleName = specifier.slice(leadingDots).replace(/\./g, '/');
  let baseDirectory = '';

  if (leadingDots > 0) {
    baseDirectory = path.posix.dirname(normalizedImporter);
    for (let index = 1; index < leadingDots; index += 1) {
      baseDirectory = path.posix.dirname(baseDirectory);
    }
  }

  const modulePath = path.posix.normalize(
    path.posix.join(baseDirectory, moduleName)
  );
  const resolvedFromRoot = findSourceCandidate(modulePath, availablePaths, ['.py']);
  if (resolvedFromRoot !== undefined || leadingDots > 0) {
    return resolvedFromRoot;
  }
  return findSourceCandidate(
    path.posix.join(path.posix.dirname(normalizedImporter), moduleName),
    availablePaths,
    ['.py']
  );
}

function findSourceCandidate(
  basePath: string,
  availablePaths: ReadonlySet<string>,
  extensions: readonly string[]
): string | undefined {
  const normalizedBase = normalizePath(basePath);
  const candidates: string[] = [];
  if (SOURCE_EXTENSIONS.includes(path.posix.extname(normalizedBase))) {
    candidates.push(normalizedBase);
  } else {
    for (const extension of extensions) {
      candidates.push(`${normalizedBase}${extension}`);
    }
    for (const extension of extensions) {
      candidates.push(path.posix.join(normalizedBase, `index${extension}`));
    }
    if (extensions.includes('.py')) {
      candidates.push(path.posix.join(normalizedBase, '__init__.py'));
    }
  }
  return candidates.find((candidate) => availablePaths.has(candidate));
}

function normalizePath(filePath: string): string {
  return filePath.replaceAll('\\', '/').replace(/^\.\//, '');
}

function countLines(content: string): number {
  if (content.length === 0) {
    return 1;
  }
  return content.split(/\r?\n/).length;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
