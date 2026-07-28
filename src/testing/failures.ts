import path from 'node:path';
import type {
  GraphNode,
  NodeTestFailures,
  TestFailureDetail
} from '../scanner/model';

export interface StackFrame {
  path: string;
  line: number;
  character: number;
}

export interface ParsedFailure {
  testName: string;
  message: string;
  stack: string;
  source: 'test' | 'runtime';
  frames: StackFrame[];
}

export interface FailureMapping {
  failures: NodeTestFailures;
  testErrorNodeIds: string[];
  runtimeErrorNodeIds: string[];
}

export function parseTestFailures(output: string): ParsedFailure[] {
  const clean = stripAnsi(output).replaceAll('\r\n', '\n');
  const headers = failureHeaders(clean);
  if (headers.length === 0) {
    const frames = parseStackFrames(clean);
    return frames.length === 0
      ? []
      : [{
        testName: runtimeMarker(clean) ? 'Uncaught exception' : 'Test command failure',
        message: firstMeaningfulLine(clean),
        stack: clean.trim(),
        source: runtimeMarker(clean) ? 'runtime' : 'test',
        frames
      }];
  }

  return headers.map<ParsedFailure>((header, index) => {
    const end = headers[index + 1]?.index ?? clean.length;
    const block = clean.slice(header.index, end).trim();
    return {
      testName: header.name,
      message: firstMeaningfulLine(block.slice(header.header.length)),
      stack: block,
      source: header.runtime || runtimeMarker(block) ? 'runtime' : 'test',
      frames: parseStackFrames(block)
    };
  }).filter((failure) => failure.frames.length > 0);
}

export function mapFailuresToNodes(
  nodes: readonly GraphNode[],
  failures: readonly ParsedFailure[],
  workspaceRoot: string
): FailureMapping {
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

  const details = new Map<string, TestFailureDetail[]>();
  const testIds = new Set<string>();
  const runtimeIds = new Set<string>();
  for (const failure of failures) {
    const mappedFrame = failure.frames
      .map((frame) => ({
        frame,
        file: resolveFileNode(frame.path, files, workspaceRoot)
      }))
      .find((entry) => entry.file !== undefined);
    if (!mappedFrame?.file) {
      continue;
    }
    const line = mappedFrame.frame.line;
    const functions = (functionsByPath.get(mappedFrame.file.id) ?? [])
      .filter((node) => node.range.startLine <= line && line <= node.range.endLine)
      .sort((left, right) =>
        (left.range.endLine - left.range.startLine)
        - (right.range.endLine - right.range.startLine)
      );
    const targetIds = [
      mappedFrame.file.id,
      ...(functions[0] ? [functions[0].id] : [])
    ];
    const detail: TestFailureDetail = {
      id: [
        failure.source,
        failure.testName,
        mappedFrame.file.id,
        line,
        mappedFrame.frame.character
      ].join('\0'),
      testName: failure.testName,
      message: failure.message,
      stack: failure.stack,
      source: failure.source,
      fileId: mappedFrame.file.id,
      line,
      character: mappedFrame.frame.character
    };
    for (const nodeId of targetIds) {
      const existing = details.get(nodeId) ?? [];
      if (!existing.some((candidate) => candidate.id === detail.id)) {
        existing.push({ ...detail });
        details.set(nodeId, existing);
      }
      (failure.source === 'runtime' ? runtimeIds : testIds).add(nodeId);
    }
  }
  return {
    failures: Object.fromEntries([...details.entries()]),
    testErrorNodeIds: [...testIds].sort(),
    runtimeErrorNodeIds: [...runtimeIds].sort()
  };
}

export function parseStackFrames(value: string): StackFrame[] {
  const frames: StackFrame[] = [];
  const seen = new Set<string>();
  for (const line of stripAnsi(value).split(/\r?\n/)) {
    const python = line.match(/\bFile "([^"]+)", line (\d+)/);
    const js = line.match(/(?:\(|\s|^)((?:[A-Za-z]:)?[^()\s]+?\.(?:[cm]?[jt]sx?|py)):(\d+)(?::(\d+))?(?:\)|\s|$)/);
    const pytest = line.match(/^\s*((?:[A-Za-z]:)?[^:\s]+\.py):(\d+)(?::(\d+))?(?::|\s|$)/);
    const match = python
      ? { path: python[1], line: Number(python[2]) - 1, character: 0 }
      : js
        ? {
          path: js[1],
          line: Number(js[2]) - 1,
          character: js[3] ? Number(js[3]) - 1 : 0
        }
        : pytest
          ? {
            path: pytest[1],
            line: Number(pytest[2]) - 1,
            character: pytest[3] ? Number(pytest[3]) - 1 : 0
          }
          : undefined;
    if (!match || match.line < 0 || match.character < 0) {
      continue;
    }
    const key = `${match.path}\0${match.line}\0${match.character}`;
    if (!seen.has(key)) {
      seen.add(key);
      frames.push(match);
    }
  }
  return frames;
}

interface FailureHeader {
  index: number;
  header: string;
  name: string;
  runtime: boolean;
}

function failureHeaders(output: string): FailureHeader[] {
  const headers: FailureHeader[] = [];
  const patterns: Array<{ expression: RegExp; runtime: boolean }> = [
    { expression: /^\s*FAIL\s+(.+)$/gm, runtime: false },
    { expression: /^\s*●\s+(.+)$/gm, runtime: false },
    { expression: /^_{3,}\s+(.+?)\s+_{3,}$/gm, runtime: false },
    { expression: /^\s*(Uncaught (?:Exception|Error)|Unhandled Rejection)\b.*$/gmi, runtime: true }
  ];
  for (const { expression, runtime } of patterns) {
    for (const match of output.matchAll(expression)) {
      if (match.index === undefined) {
        continue;
      }
      headers.push({
        index: match.index,
        header: match[0],
        name: (match[1] ?? match[0]).trim(),
        runtime
      });
    }
  }
  return headers.sort((left, right) => left.index - right.index);
}

function resolveFileNode(
  framePath: string,
  files: readonly GraphNode[],
  workspaceRoot: string
): GraphNode | undefined {
  const normalized = normalizePath(framePath);
  const relative = normalizePath(
    path.isAbsolute(framePath) ? path.relative(workspaceRoot, framePath) : framePath
  );
  const exact = files.find((file) =>
    normalizePath(file.id) === relative || normalizePath(file.path) === relative
  );
  if (exact) {
    return exact;
  }
  const suffix = files.filter((file) =>
    normalized.endsWith(`/${normalizePath(file.id)}`)
    || normalized.endsWith(`/${normalizePath(file.path)}`)
  );
  return suffix.length === 1 ? suffix[0] : undefined;
}

function runtimeMarker(value: string): boolean {
  return /\b(?:uncaught|unhandled rejection|uncaught exception)\b/i.test(value);
}

function firstMeaningfulLine(value: string): string {
  return value.split('\n').map((line) => line.trim()).find(Boolean)
    ?? 'Test command failed.';
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^[A-Z]:/i, (drive) =>
    drive.toLowerCase()
  ).replace(/^\.\/+/, '');
}
