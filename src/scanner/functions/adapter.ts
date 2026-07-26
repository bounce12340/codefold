import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { SupportedLanguage } from '../model';

export type DefinitionKind = 'class' | 'function' | 'method';

export interface ParsedDefinition {
  name: string;
  kind: DefinitionKind;
  className: string | null;
  exportedNames: string[];
  startIndex: number;
  endIndex: number;
  range: { startLine: number; endLine: number };
}

export interface ParsedCall {
  callerName: string;
  callerClassName: string | null;
  name: string;
  qualifier: string | null;
}

export interface ImportBinding {
  localName: string;
  importedName: string | null;
  specifier: string;
  namespace: boolean;
}

export interface LanguageAnalysis {
  definitions: ParsedDefinition[];
  calls: ParsedCall[];
  imports: ImportBinding[];
}

export interface LanguageAdapter {
  readonly language: SupportedLanguage;
  analyze(root: SyntaxNode): LanguageAnalysis;
}

export function walkNamed(
  node: SyntaxNode,
  visit: (node: SyntaxNode) => void
): void {
  visit(node);
  for (const child of node.namedChildren) {
    walkNamed(child, visit);
  }
}

export function containingDefinition(
  definitions: readonly ParsedDefinition[],
  node: SyntaxNode
): ParsedDefinition | undefined {
  let match: ParsedDefinition | undefined;
  for (const definition of definitions) {
    if (
      definition.startIndex <= node.startIndex
      && definition.endIndex >= node.endIndex
      && (
        match === undefined
        || definition.endIndex - definition.startIndex
          < match.endIndex - match.startIndex
      )
    ) {
      match = definition;
    }
  }
  return match;
}

export function syntaxNodeText(node: SyntaxNode | null): string | undefined {
  const value = node?.text.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

export function definitionRange(
  node: SyntaxNode
): { startLine: number; endLine: number } {
  return {
    startLine: node.startPosition.row,
    endLine: node.endPosition.row
  };
}
