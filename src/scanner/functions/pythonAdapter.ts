import type { Node as SyntaxNode } from 'web-tree-sitter';
import type {
  ImportBinding,
  LanguageAdapter,
  LanguageAnalysis,
  ParsedCall,
  ParsedDefinition
} from './adapter';
import {
  containingDefinition,
  definitionRange,
  syntaxNodeText,
  walkNamed
} from './adapter';

export class PythonLanguageAdapter implements LanguageAdapter {
  readonly language = 'py' as const;

  analyze(root: SyntaxNode): LanguageAnalysis {
    const definitions: ParsedDefinition[] = [];
    collectDefinitions(root, [], null, false, definitions);
    return {
      definitions,
      calls: collectCalls(root, definitions),
      imports: collectImports(root)
    };
  }
}

function collectDefinitions(
  node: SyntaxNode,
  scope: readonly string[],
  className: string | null,
  inClassBody: boolean,
  definitions: ParsedDefinition[]
): void {
  if (node.type === 'class_definition') {
    const simpleName = syntaxNodeText(node.childForFieldName('name'));
    if (simpleName !== undefined) {
      const name = [...scope, simpleName].join('.');
      definitions.push(createDefinition(node, name, 'class', null));
      for (const child of node.namedChildren) {
        collectDefinitions(child, scope, name, true, definitions);
      }
      return;
    }
  }
  if (node.type === 'function_definition') {
    const simpleName = syntaxNodeText(node.childForFieldName('name'));
    if (simpleName !== undefined) {
      const isMethod = className !== null && inClassBody;
      const name = isMethod
        ? `${className}.${simpleName}`
        : [...scope, simpleName].join('.');
      const kind = isMethod ? 'method' : 'function';
      definitions.push(createDefinition(node, name, kind, className));
      for (const child of node.namedChildren) {
        collectDefinitions(child, [name], className, false, definitions);
      }
      return;
    }
  }
  for (const child of node.namedChildren) {
    collectDefinitions(child, scope, className, inClassBody, definitions);
  }
}

function createDefinition(
  node: SyntaxNode,
  name: string,
  kind: ParsedDefinition['kind'],
  className: string | null
): ParsedDefinition {
  return {
    name,
    kind,
    className,
    exportedNames: [name],
    startIndex: node.startIndex,
    endIndex: node.endIndex,
    range: definitionRange(node)
  };
}

function collectCalls(
  root: SyntaxNode,
  definitions: readonly ParsedDefinition[]
): ParsedCall[] {
  const calls: ParsedCall[] = [];
  walkNamed(root, (node) => {
    if (node.type !== 'call') {
      return;
    }
    const caller = containingDefinition(definitions, node);
    const callee = node.childForFieldName('function');
    if (caller === undefined || callee === null) {
      return;
    }
    const reference = callReference(callee);
    if (reference !== undefined) {
      calls.push({
        callerName: caller.name,
        callerClassName: caller.className,
        ...reference
      });
    }
  });
  return calls;
}

function callReference(
  callee: SyntaxNode
): { name: string; qualifier: string | null } | undefined {
  if (callee.type === 'identifier') {
    return { name: callee.text, qualifier: null };
  }
  if (callee.type !== 'attribute') {
    return undefined;
  }
  const object = callee.childForFieldName('object');
  const attribute = callee.namedChildren.at(-1);
  if (object?.type !== 'identifier' || attribute?.type !== 'identifier') {
    return undefined;
  }
  return { name: attribute.text, qualifier: object.text };
}

function collectImports(root: SyntaxNode): ImportBinding[] {
  const imports: ImportBinding[] = [];
  walkNamed(root, (node) => {
    if (node.type === 'import_statement') {
      imports.push(...parseDirectImport(node.text));
    } else if (node.type === 'import_from_statement') {
      imports.push(...parseFromImport(node.text));
    }
  });
  return imports;
}

function parseDirectImport(text: string): ImportBinding[] {
  const match = /^import\s+([\s\S]+)$/.exec(normalizeImportText(text));
  if (match?.[1] === undefined) {
    return [];
  }
  return match[1].split(',').flatMap((entry) => {
    const alias = /^([\w.]+)(?:\s+as\s+(\w+))?$/.exec(entry.trim());
    if (alias?.[1] === undefined) {
      return [];
    }
    return [{
      localName: alias[2] ?? alias[1].split('.')[0],
      importedName: null,
      specifier: alias[1],
      namespace: true
    }];
  });
}

function parseFromImport(text: string): ImportBinding[] {
  const match = /^from\s+([.\w]+)\s+import\s+([\s\S]+)$/.exec(
    normalizeImportText(text)
  );
  if (match?.[1] === undefined || match[2] === undefined) {
    return [];
  }
  const moduleName = match[1];
  const bindings: ImportBinding[] = [];
  for (const entry of match[2].split(',')) {
    const alias = /^(\w+)(?:\s+as\s+(\w+))?$/.exec(entry.trim());
    if (alias?.[1] === undefined || alias[1] === '*') {
      continue;
    }
    if (/^\.+$/.test(moduleName)) {
      bindings.push({
        localName: alias[2] ?? alias[1],
        importedName: null,
        specifier: `${moduleName}${alias[1]}`,
        namespace: true
      });
    } else {
      bindings.push({
        localName: alias[2] ?? alias[1],
        importedName: alias[1],
        specifier: moduleName,
        namespace: false
      });
    }
  }
  return bindings;
}

function normalizeImportText(text: string): string {
  return text.replace(/[()\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
}
