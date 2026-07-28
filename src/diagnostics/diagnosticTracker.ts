import type {
  DiagnosticSeverity,
  GraphNode,
  NodeDiagnostic,
  NodeDiagnostics
} from '../scanner/model';
import { NodeStateStore } from '../state/nodeStateMachine';

export interface DiagnosticInput {
  fileId: string;
  source?: string;
  message: string;
  severity: DiagnosticSeverity;
  range: NodeDiagnostic['range'];
}

export interface DiagnosticMapping {
  diagnostics: NodeDiagnostics;
  errorNodeIds: string[];
}

export class DiagnosticTracker {
  private current: NodeDiagnostics = {};

  constructor(
    private readonly nodes: readonly GraphNode[],
    private readonly stateStore: NodeStateStore
  ) {}

  apply(inputs: readonly DiagnosticInput[]): NodeDiagnostics {
    const mapping = mapDiagnosticsToNodes(this.nodes, inputs);
    this.current = mapping.diagnostics;
    this.stateStore.replaceErrorSource('diagnostic', mapping.errorNodeIds);
    return this.snapshot();
  }

  snapshot(): NodeDiagnostics {
    return Object.fromEntries(
      Object.entries(this.current).map(([nodeId, diagnostics]) => [
        nodeId,
        diagnostics.map(cloneDiagnostic)
      ])
    );
  }
}

export function mapDiagnosticsToNodes(
  nodes: readonly GraphNode[],
  inputs: readonly DiagnosticInput[]
): DiagnosticMapping {
  const files = new Map(
    nodes.filter((node) => node.kind === 'file').map((node) => [node.id, node])
  );
  const functionsByPath = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    if (node.kind !== 'function') {
      continue;
    }
    const siblings = functionsByPath.get(node.path) ?? [];
    siblings.push(node);
    functionsByPath.set(node.path, siblings);
  }

  const diagnostics = new Map<string, NodeDiagnostic[]>();
  const errorNodeIds = new Set<string>();
  for (const input of inputs) {
    if (!files.has(input.fileId)) {
      continue;
    }
    const detail = toNodeDiagnostic(input);
    const effectiveEndLine =
      input.range.endCharacter === 0
      && input.range.endLine > input.range.startLine
        ? input.range.endLine - 1
        : input.range.endLine;
    const targets = [
      input.fileId,
      ...(functionsByPath.get(input.fileId) ?? [])
        .filter((node) =>
          rangesOverlap(
            node.range.startLine,
            node.range.endLine,
            input.range.startLine,
            effectiveEndLine
          )
        )
        .map((node) => node.id)
    ];
    for (const nodeId of new Set(targets)) {
      const existing = diagnostics.get(nodeId) ?? [];
      if (!existing.some((candidate) => candidate.id === detail.id)) {
        existing.push(detail);
        diagnostics.set(nodeId, existing);
      }
      if (input.severity === 'error') {
        errorNodeIds.add(nodeId);
      }
    }
  }

  return {
    diagnostics: Object.fromEntries(
      [...diagnostics.entries()].map(([nodeId, details]) => [
        nodeId,
        details.sort(compareDiagnostics).map(cloneDiagnostic)
      ])
    ),
    errorNodeIds: [...errorNodeIds].sort()
  };
}

function toNodeDiagnostic(input: DiagnosticInput): NodeDiagnostic {
  const source = input.source?.trim() || 'VS Code';
  const range = { ...input.range };
  return {
    id: [
      input.fileId,
      range.startLine,
      range.startCharacter,
      range.endLine,
      range.endCharacter,
      input.severity,
      source,
      input.message
    ].join('\0'),
    fileId: input.fileId,
    source,
    message: input.message,
    severity: input.severity,
    range
  };
}

function compareDiagnostics(
  left: NodeDiagnostic,
  right: NodeDiagnostic
): number {
  return (
    left.range.startLine - right.range.startLine
    || left.range.startCharacter - right.range.startCharacter
    || severityRank(left.severity) - severityRank(right.severity)
    || left.source.localeCompare(right.source)
    || left.message.localeCompare(right.message)
  );
}

function severityRank(severity: DiagnosticSeverity): number {
  return ['error', 'warning', 'information', 'hint'].indexOf(severity);
}

function rangesOverlap(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number
): boolean {
  return leftStart <= rightEnd && rightStart <= leftEnd;
}

function cloneDiagnostic(diagnostic: NodeDiagnostic): NodeDiagnostic {
  return {
    ...diagnostic,
    range: { ...diagnostic.range }
  };
}
