import path from 'node:path';
import { Language, Parser } from 'web-tree-sitter';
import { languageForPath, resolveImport } from '../imports';
import type {
  FileGraph,
  GraphEdge,
  GraphNode,
  SourceFile
} from '../model';
import type {
  ImportBinding,
  LanguageAdapter,
  LanguageAnalysis,
  ParsedCall,
  ParsedDefinition
} from './adapter';
import { PythonLanguageAdapter } from './pythonAdapter';
import { TypeScriptLanguageAdapter } from './typescriptAdapter';

export interface FunctionGraph extends FileGraph {
  unresolvedCalls: number;
}

export interface FunctionGraphOptions {
  wasmDirectory?: string;
  onDiagnostic?: (message: string) => void;
}

type GrammarName = 'javascript' | 'python' | 'tsx' | 'typescript';

interface AnalyzedFile {
  file: SourceFile;
  analysis: LanguageAnalysis;
}

let parserInitialization: Promise<void> | undefined;

export async function buildFunctionGraph(
  files: readonly SourceFile[],
  options: FunctionGraphOptions = {}
): Promise<FunctionGraph> {
  const onDiagnostic = options.onDiagnostic
    ?? ((message: string) => console.error(message));
  parserInitialization ??= Parser.init({
    locateFile: () => wasmPath('web-tree-sitter', options.wasmDirectory)
  });
  await parserInitialization;

  const normalizedFiles = files
    .map((file) => ({ ...file, path: normalizePath(file.path) }))
    .filter((file) => languageForPath(file.path) !== undefined)
    .sort((left, right) => left.path.localeCompare(right.path));
  const analyses: AnalyzedFile[] = [];
  const languages = new Map<GrammarName, Language>();
  const parsers = new Map<GrammarName, Parser>();

  try {
    for (const file of normalizedFiles) {
      const grammarName = grammarForPath(file.path);
      const adapter = adapterForPath(file.path);
      if (grammarName === undefined || adapter === undefined) {
        continue;
      }
      try {
        let language = languages.get(grammarName);
        if (language === undefined) {
          language = await Language.load(
            wasmPath(grammarName, options.wasmDirectory)
          );
          languages.set(grammarName, language);
        }
        let parser = parsers.get(grammarName);
        if (parser === undefined) {
          parser = new Parser();
          parser.setLanguage(language);
          parsers.set(grammarName, parser);
        }
        const tree = parser.parse(file.content);
        if (tree === null) {
          onDiagnostic(`Tree-sitter returned no syntax tree for ${file.path}.`);
          continue;
        }
        try {
          if (tree.rootNode.hasError) {
            onDiagnostic(
              `Tree-sitter found syntax errors in ${file.path}; `
              + 'CodeFold extracted only the definitions it could identify.'
            );
          }
          analyses.push({ file, analysis: adapter.analyze(tree.rootNode) });
        } finally {
          tree.delete();
        }
      } catch (error) {
        onDiagnostic(
          `Could not parse functions in ${file.path}: ${formatError(error)}`
        );
      }
    }
  } finally {
    for (const parser of parsers.values()) {
      parser.delete();
    }
  }

  return assembleFunctionGraph(analyses, onDiagnostic);
}

function assembleFunctionGraph(
  files: readonly AnalyzedFile[],
  onDiagnostic: (message: string) => void
): FunctionGraph {
  const availablePaths = new Set(files.map(({ file }) => file.path));
  const analysisByPath = new Map(files.map((entry) => [entry.file.path, entry.analysis]));
  const nodes: GraphNode[] = [];
  const definitionsByPath = new Map<string, Map<string, ParsedDefinition>>();

  for (const { file, analysis } of files) {
    const language = languageForPath(file.path);
    if (language === undefined) {
      continue;
    }
    const definitions = new Map<string, ParsedDefinition>();
    for (const definition of analysis.definitions) {
      if (definitions.has(definition.name)) {
        onDiagnostic(
          `Skipped duplicate symbol ${file.path}#${definition.name}; `
          + 'Phase 1 ids use path#symbolName.'
        );
        continue;
      }
      definitions.set(definition.name, definition);
      nodes.push({
        id: `${file.path}#${definition.name}`,
        kind: 'function',
        path: file.path,
        name: definition.name,
        range: definition.range,
        lang: language,
        state: 'idle',
        errorSources: [],
        editingAgents: [],
        annotation: { auto: null, manual: null },
        lastVerifiedAt: null
      });
    }
    definitionsByPath.set(file.path, definitions);
  }

  const edges: GraphEdge[] = nodes.map((node) => ({
    from: node.path,
    to: node.id,
    kind: 'contains'
  }));
  const seenCalls = new Set<string>();
  let unresolvedCalls = 0;

  for (const { file, analysis } of files) {
    const localDefinitions = definitionsByPath.get(file.path);
    if (localDefinitions === undefined) {
      continue;
    }
    const importBindings = resolveImportBindings(
      file.path,
      analysis.imports,
      availablePaths
    );
    for (const call of analysis.calls) {
      const target = resolveCall(
        file.path,
        call,
        localDefinitions,
        importBindings,
        analysisByPath,
        definitionsByPath
      );
      if (target === undefined) {
        unresolvedCalls += 1;
        continue;
      }
      const from = `${file.path}#${call.callerName}`;
      const to = `${target.path}#${target.definition.name}`;
      if (from === to) {
        continue;
      }
      const key = `${from}\0${to}`;
      if (!seenCalls.has(key)) {
        seenCalls.add(key);
        edges.push({ from, to, kind: 'call' });
      }
    }
  }

  if (unresolvedCalls > 0) {
    // Dynamic dispatch and calls into dependencies/built-ins are intentionally
    // omitted because Phase 1 only draws statically certain workspace targets.
    onDiagnostic(
      `Skipped ${unresolvedCalls} unresolved or dynamic function call(s); `
      + 'CodeFold links only direct local and workspace-imported symbols.'
    );
  }
  nodes.sort((left, right) => left.id.localeCompare(right.id));
  edges.sort((left, right) =>
    `${left.kind}\0${left.from}\0${left.to}`.localeCompare(
      `${right.kind}\0${right.from}\0${right.to}`
    )
  );
  return { nodes, edges, unresolvedCalls };
}

interface ResolvedImportBinding extends ImportBinding {
  targetPath: string;
}

function resolveImportBindings(
  filePath: string,
  bindings: readonly ImportBinding[],
  availablePaths: ReadonlySet<string>
): Map<string, ResolvedImportBinding> {
  const resolved = new Map<string, ResolvedImportBinding>();
  for (const binding of bindings) {
    const targetPath = resolveImport(filePath, binding.specifier, availablePaths);
    if (targetPath !== undefined) {
      resolved.set(binding.localName, { ...binding, targetPath });
    }
  }
  return resolved;
}

function resolveCall(
  filePath: string,
  call: ParsedCall,
  localDefinitions: ReadonlyMap<string, ParsedDefinition>,
  imports: ReadonlyMap<string, ResolvedImportBinding>,
  analysisByPath: ReadonlyMap<string, LanguageAnalysis>,
  definitionsByPath: ReadonlyMap<string, ReadonlyMap<string, ParsedDefinition>>
): { path: string; definition: ParsedDefinition } | undefined {
  if (call.qualifier === null) {
    const local = localDefinitions.get(call.name)
      ?? nestedLocalDefinition(call, localDefinitions);
    if (local !== undefined) {
      return { path: filePath, definition: local };
    }
    const binding = imports.get(call.name);
    if (binding !== undefined && !binding.namespace) {
      const definition = importedDefinition(
        binding,
        binding.importedName ?? call.name,
        analysisByPath,
        definitionsByPath
      );
      if (definition !== undefined) {
        return { path: binding.targetPath, definition };
      }
    }
    return undefined;
  }

  if (
    (call.qualifier === 'this' || call.qualifier === 'self')
    && call.callerClassName !== null
  ) {
    const method = localDefinitions.get(`${call.callerClassName}.${call.name}`);
    if (method !== undefined) {
      return {
        path: filePath,
        definition: method
      };
    }
  }
  const localMember = localDefinitions.get(`${call.qualifier}.${call.name}`);
  if (localMember !== undefined) {
    return {
      path: filePath,
      definition: localMember
    };
  }
  const binding = imports.get(call.qualifier);
  if (binding?.namespace) {
    const definition = importedDefinition(
      binding,
      call.name,
      analysisByPath,
      definitionsByPath
    );
    if (definition !== undefined) {
      return { path: binding.targetPath, definition };
    }
  }
  return undefined;
}

function nestedLocalDefinition(
  call: ParsedCall,
  definitions: ReadonlyMap<string, ParsedDefinition>
): ParsedDefinition | undefined {
  const scope = call.callerName.split('.');
  while (scope.length > 0) {
    const definition = definitions.get(`${scope.join('.')}.${call.name}`);
    if (definition !== undefined) {
      return definition;
    }
    scope.pop();
  }
  return undefined;
}

function importedDefinition(
  binding: ResolvedImportBinding,
  importedName: string,
  analysisByPath: ReadonlyMap<string, LanguageAnalysis>,
  definitionsByPath: ReadonlyMap<string, ReadonlyMap<string, ParsedDefinition>>
): ParsedDefinition | undefined {
  const definitions = definitionsByPath.get(binding.targetPath);
  const analysis = analysisByPath.get(binding.targetPath);
  if (definitions === undefined || analysis === undefined) {
    return undefined;
  }
  const direct = definitions.get(importedName);
  if (direct !== undefined) {
    return direct;
  }
  return analysis.definitions.find(
    (definition) => definition.exportedNames.includes(importedName)
  );
}

function adapterForPath(filePath: string): LanguageAdapter | undefined {
  const language = languageForPath(filePath);
  if (language === 'py') {
    return new PythonLanguageAdapter();
  }
  if (language === 'ts' || language === 'js') {
    return new TypeScriptLanguageAdapter(language);
  }
  return undefined;
}

function grammarForPath(filePath: string): GrammarName | undefined {
  switch (path.posix.extname(normalizePath(filePath)).toLowerCase()) {
    case '.ts':
      return 'typescript';
    case '.tsx':
      return 'tsx';
    case '.js':
    case '.jsx':
      return 'javascript';
    case '.py':
      return 'python';
    default:
      return undefined;
  }
}

function wasmPath(
  grammar: GrammarName | 'web-tree-sitter',
  wasmDirectory: string | undefined
): string {
  if (wasmDirectory !== undefined) {
    return path.join(wasmDirectory, `${grammar}.wasm`);
  }
  const modules = path.resolve(process.cwd(), 'node_modules');
  if (grammar === 'web-tree-sitter') {
    return path.join(modules, 'web-tree-sitter', 'web-tree-sitter.wasm');
  }
  const packageName = grammar === 'tsx' || grammar === 'typescript'
    ? 'tree-sitter-typescript'
    : `tree-sitter-${grammar}`;
  return path.join(modules, packageName, `tree-sitter-${grammar}.wasm`);
}

function normalizePath(filePath: string): string {
  return filePath.replaceAll('\\', '/').replace(/^\.\//, '');
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
