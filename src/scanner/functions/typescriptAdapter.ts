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

const FUNCTION_VALUE_TYPES = new Set(['arrow_function', 'function_expression']);

export class TypeScriptLanguageAdapter implements LanguageAdapter {
  readonly language: 'ts' | 'js';

  constructor(language: 'ts' | 'js') {
    this.language = language;
  }

  analyze(root: SyntaxNode): LanguageAnalysis {
    const definitions: ParsedDefinition[] = [];
    collectDefinitions(root, [], null, definitions);
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
  definitions: ParsedDefinition[]
): void {
  if (node.type === 'class_declaration' || node.type === 'class') {
    const simpleName = syntaxNodeText(node.childForFieldName('name'));
    if (simpleName !== undefined) {
      const name = [...scope, simpleName].join('.');
      definitions.push(createDefinition(node, name, 'class', null));
      for (const child of node.namedChildren) {
        collectDefinitions(child, scope, name, definitions);
      }
      return;
    }
  }

  if (node.type === 'method_definition') {
    const simpleName = syntaxNodeText(node.childForFieldName('name'));
    if (simpleName !== undefined) {
      const name = className === null
        ? [...scope, simpleName].join('.')
        : `${className}.${simpleName}`;
      definitions.push(createDefinition(node, name, 'method', className));
      for (const child of node.namedChildren) {
        collectDefinitions(child, [name], className, definitions);
      }
      return;
    }
  }

  if (node.type === 'function_declaration') {
    const simpleName = syntaxNodeText(node.childForFieldName('name'));
    if (simpleName !== undefined) {
      const name = [...scope, simpleName].join('.');
      definitions.push(createDefinition(node, name, 'function', className));
      for (const child of node.namedChildren) {
        collectDefinitions(child, [name], className, definitions);
      }
      return;
    }
  }

  if (node.type === 'variable_declarator') {
    const value = node.childForFieldName('value');
    const simpleName = syntaxNodeText(node.childForFieldName('name'));
    if (
      value !== null
      && FUNCTION_VALUE_TYPES.has(value.type)
      && simpleName !== undefined
      && /^[A-Za-z_$][\w$]*$/.test(simpleName)
    ) {
      const name = [...scope, simpleName].join('.');
      definitions.push(createDefinition(node, name, 'function', className));
      for (const child of value.namedChildren) {
        collectDefinitions(child, [name], className, definitions);
      }
      return;
    }
  }

  for (const child of node.namedChildren) {
    collectDefinitions(child, scope, className, definitions);
  }
}

function createDefinition(
  node: SyntaxNode,
  name: string,
  kind: ParsedDefinition['kind'],
  className: string | null
): ParsedDefinition {
  const exportedNames = [name];
  const parent = node.parent;
  if (
    parent?.type === 'export_statement'
    && parent.children.some((child) => child.type === 'default')
  ) {
    exportedNames.push('default');
  }
  return {
    name,
    kind,
    className,
    exportedNames,
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
    if (node.type !== 'call_expression' && node.type !== 'new_expression') {
      return;
    }
    const caller = containingDefinition(definitions, node);
    const callee = node.childForFieldName(
      node.type === 'new_expression' ? 'constructor' : 'function'
    );
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
  if (callee.type === 'identifier' || callee.type === 'type_identifier') {
    return { name: callee.text, qualifier: null };
  }
  if (callee.type !== 'member_expression') {
    return undefined;
  }
  const object = callee.childForFieldName('object');
  const property = callee.childForFieldName('property');
  if (
    object === null
    || property === null
    || !['identifier', 'this', 'type_identifier'].includes(object.type)
  ) {
    return undefined;
  }
  return { name: property.text, qualifier: object.text };
}

function collectImports(root: SyntaxNode): ImportBinding[] {
  const imports: ImportBinding[] = [];
  walkNamed(root, (node) => {
    if (node.type === 'import_statement') {
      imports.push(...parseImportStatement(node));
    } else if (node.type === 'variable_declarator') {
      imports.push(...parseRequireDeclarator(node));
    }
  });
  return imports;
}

function parseImportStatement(node: SyntaxNode): ImportBinding[] {
  const source = node.namedChildren.find((child) => child.type === 'string');
  const specifier = source === undefined ? undefined : unquote(source.text);
  const clause = node.namedChildren.find((child) => child.type === 'import_clause');
  if (specifier === undefined || clause === undefined) {
    return [];
  }
  const bindings: ImportBinding[] = [];
  const defaultImport = clause.namedChildren.find(
    (child) => child.type === 'identifier'
  );
  if (defaultImport !== undefined) {
    bindings.push({
      localName: defaultImport.text,
      importedName: 'default',
      specifier,
      namespace: false
    });
  }
  const namespaceImport = clause.namedChildren.find(
    (child) => child.type === 'namespace_import'
  );
  const namespaceName = namespaceImport?.namedChildren.find(
    (child) => child.type === 'identifier'
  );
  if (namespaceName !== undefined) {
    bindings.push({
      localName: namespaceName.text,
      importedName: null,
      specifier,
      namespace: true
    });
  }
  const namedImports = clause.namedChildren.find(
    (child) => child.type === 'named_imports'
  );
  for (const importSpecifier of namedImports?.namedChildren ?? []) {
    const names = importSpecifier.namedChildren.filter(
      (child) => child.type === 'identifier'
    );
    const importedName = syntaxNodeText(importSpecifier.childForFieldName('name'))
      ?? names[0]?.text;
    const localName = names.at(-1)?.text;
    if (importedName !== undefined && localName !== undefined) {
      bindings.push({
        localName,
        importedName,
        specifier,
        namespace: false
      });
    }
  }
  return bindings;
}

function parseRequireDeclarator(node: SyntaxNode): ImportBinding[] {
  const value = node.childForFieldName('value');
  const name = node.childForFieldName('name');
  if (
    value?.type !== 'call_expression'
    || value.childForFieldName('function')?.text !== 'require'
    || name === null
  ) {
    return [];
  }
  const source = value.namedChildren
    .find((child) => child.type === 'arguments')
    ?.namedChildren.find((child) => child.type === 'string');
  const specifier = source === undefined ? undefined : unquote(source.text);
  if (specifier === undefined) {
    return [];
  }
  if (name.type === 'identifier') {
    return [{
      localName: name.text,
      importedName: null,
      specifier,
      namespace: true
    }];
  }
  if (name.type !== 'object_pattern') {
    return [];
  }
  const bindings: ImportBinding[] = [];
  for (const child of name.namedChildren) {
    if (child.type === 'shorthand_property_identifier_pattern') {
      bindings.push({
        localName: child.text,
        importedName: child.text,
        specifier,
        namespace: false
      });
    } else if (child.type === 'pair_pattern') {
      const importedName = syntaxNodeText(child.childForFieldName('key'));
      const localName = syntaxNodeText(child.childForFieldName('value'));
      if (importedName !== undefined && localName !== undefined) {
        bindings.push({
          localName,
          importedName,
          specifier,
          namespace: false
        });
      }
    }
  }
  return bindings;
}

function unquote(value: string): string | undefined {
  const quote = value[0];
  if ((quote !== '"' && quote !== "'") || value.at(-1) !== quote) {
    return undefined;
  }
  return value.slice(1, -1);
}
