import path from 'node:path';
import type { GraphNode } from '../scanner/model';

export interface CoverageRecord {
  path: string;
  executedLines: number[];
}

export interface CoverageMapping {
  nodeIds: string[];
  sequence: string[];
}

export function parseCoverageJson(value: string): CoverageRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Coverage JSON is invalid: ${formatError(error)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error('Coverage JSON must contain an object at the top level.');
  }
  if ('files' in parsed && isRecord(parsed.files)) {
    return parseCoveragePy(parsed.files);
  }
  return parseIstanbul(parsed);
}

export function mapCoverageToNodes(
  nodes: readonly GraphNode[],
  records: readonly CoverageRecord[],
  workspaceRoot: string
): CoverageMapping {
  const files = nodes.filter((node) => node.kind === 'file');
  const functionsByPath = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    if (node.kind !== 'function') {
      continue;
    }
    const siblings = functionsByPath.get(node.path) ?? [];
    siblings.push(node);
    functionsByPath.set(node.path, siblings);
  }
  for (const siblings of functionsByPath.values()) {
    siblings.sort((left, right) =>
      left.range.startLine - right.range.startLine
      || left.range.endLine - right.range.endLine
      || left.id.localeCompare(right.id)
    );
  }

  const sequence: string[] = [];
  const covered = new Set<string>();
  for (const record of records) {
    const file = resolveFileNode(record.path, files, workspaceRoot);
    if (!file || record.executedLines.length === 0) {
      continue;
    }
    appendUnique(sequence, covered, file.id);
    const executed = new Set(record.executedLines);
    for (const candidate of functionsByPath.get(file.id) ?? []) {
      if (
        [...executed].some((line) =>
          candidate.range.startLine <= line && line <= candidate.range.endLine
        )
      ) {
        appendUnique(sequence, covered, candidate.id);
      }
    }
  }
  return { nodeIds: [...covered].sort(), sequence };
}

function parseCoveragePy(files: Record<string, unknown>): CoverageRecord[] {
  const records: CoverageRecord[] = [];
  for (const [filePath, value] of Object.entries(files)) {
    if (!isRecord(value) || !Array.isArray(value.executed_lines)) {
      continue;
    }
    records.push({
      path: filePath,
      executedLines: uniqueLines(value.executed_lines.map((line) =>
        typeof line === 'number' ? line - 1 : Number.NaN
      ))
    });
  }
  return records;
}

function parseIstanbul(report: Record<string, unknown>): CoverageRecord[] {
  const records: CoverageRecord[] = [];
  for (const [reportPath, value] of Object.entries(report)) {
    if (!isRecord(value) || !isRecord(value.statementMap) || !isRecord(value.s)) {
      continue;
    }
    const executedLines: number[] = [];
    for (const [statementId, count] of Object.entries(value.s)) {
      if (typeof count !== 'number' || count <= 0) {
        continue;
      }
      const statement = value.statementMap[statementId];
      if (
        isRecord(statement)
        && isRecord(statement.start)
        && typeof statement.start.line === 'number'
      ) {
        executedLines.push(statement.start.line - 1);
      }
    }
    records.push({
      path: typeof value.path === 'string' ? value.path : reportPath,
      executedLines: uniqueLines(executedLines)
    });
  }
  return records;
}

function resolveFileNode(
  coveredPath: string,
  files: readonly GraphNode[],
  workspaceRoot: string
): GraphNode | undefined {
  const normalizedCovered = normalizePath(coveredPath);
  const normalizedRelative = normalizePath(
    path.isAbsolute(coveredPath)
      ? path.relative(workspaceRoot, coveredPath)
      : coveredPath
  );
  const exact = files.find((file) =>
    normalizePath(file.id) === normalizedRelative
    || normalizePath(file.path) === normalizedRelative
  );
  if (exact) {
    return exact;
  }
  const suffixMatches = files.filter((file) => {
    const id = normalizePath(file.id);
    const filePath = normalizePath(file.path);
    return normalizedCovered.endsWith(`/${id}`)
      || normalizedCovered.endsWith(`/${filePath}`);
  });
  return suffixMatches.length === 1 ? suffixMatches[0] : undefined;
}

function uniqueLines(lines: readonly number[]): number[] {
  return [...new Set(lines.filter((line) =>
    Number.isInteger(line) && line >= 0
  ))].sort((left, right) => left - right);
}

function appendUnique(
  sequence: string[],
  seen: Set<string>,
  nodeId: string
): void {
  if (!seen.has(nodeId)) {
    seen.add(nodeId);
    sequence.push(nodeId);
  }
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^[A-Z]:/i, (drive) =>
    drive.toLowerCase()
  ).replace(/^\.\/+/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
