import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  GroupLayout,
  LayoutPoint,
  WorkspaceLayout
} from '../scanner/model';

const LAYOUT_DIRECTORY = '.codefold';
const LAYOUT_FILE = 'layout.json';
const writeTails = new Map<string, Promise<void>>();

export interface WorkspaceLayoutUpdate {
  groups?: Record<string, GroupLayout>;
  files?: Record<string, LayoutPoint>;
}

export function emptyWorkspaceLayout(): WorkspaceLayout {
  return { version: 1, groups: {}, files: {} };
}

export function mergeWorkspaceLayout(
  current: WorkspaceLayout,
  update: WorkspaceLayoutUpdate
): WorkspaceLayout {
  return {
    version: 1,
    groups: { ...current.groups, ...update.groups },
    files: { ...current.files, ...update.files }
  };
}

export async function readWorkspaceLayout(
  workspaceRoot: string
): Promise<WorkspaceLayout> {
  const layoutPath = path.join(workspaceRoot, LAYOUT_DIRECTORY, LAYOUT_FILE);
  let source: string;
  try {
    source = await readFile(layoutPath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return emptyWorkspaceLayout();
    }
    throw new Error(`Could not read ${layoutPath}: ${formatError(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`Could not parse ${layoutPath}: ${formatError(error)}`);
  }
  return validateWorkspaceLayout(parsed, layoutPath);
}

export async function writeWorkspaceLayout(
  workspaceRoot: string,
  update: WorkspaceLayoutUpdate
): Promise<WorkspaceLayout> {
  return withWorkspaceWriteLock(workspaceRoot, async () => {
    const current = await readWorkspaceLayout(workspaceRoot);
    const merged = mergeWorkspaceLayout(current, update);
    const directory = path.join(workspaceRoot, LAYOUT_DIRECTORY);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, LAYOUT_FILE),
      `${JSON.stringify(merged, null, 2)}\n`,
      'utf8'
    );
    return merged;
  });
}

async function withWorkspaceWriteLock<T>(
  workspaceRoot: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = writeTails.get(workspaceRoot);
  let release = (): void => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  writeTails.set(workspaceRoot, current);
  if (previous !== undefined) {
    await previous;
  }
  try {
    return await operation();
  } finally {
    release();
    if (writeTails.get(workspaceRoot) === current) {
      writeTails.delete(workspaceRoot);
    }
  }
}

function validateWorkspaceLayout(
  value: unknown,
  layoutPath: string
): WorkspaceLayout {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error(`${layoutPath} must be a CodeFold layout with version 1.`);
  }
  if (!isRecord(value.groups) || !isRecord(value.files)) {
    throw new Error(`${layoutPath} must contain groups and files objects.`);
  }

  const groups: Record<string, GroupLayout> = {};
  for (const [id, entry] of Object.entries(value.groups)) {
    if (
      !isRecord(entry)
      || !isFiniteNumber(entry.x)
      || !isFiniteNumber(entry.y)
      || typeof entry.expanded !== 'boolean'
    ) {
      throw new Error(`Invalid group layout for ${id} in ${layoutPath}.`);
    }
    groups[id] = { x: entry.x, y: entry.y, expanded: entry.expanded };
  }

  const files: Record<string, LayoutPoint> = {};
  for (const [id, entry] of Object.entries(value.files)) {
    if (!isRecord(entry) || !isFiniteNumber(entry.x) || !isFiniteNumber(entry.y)) {
      throw new Error(`Invalid file layout for ${id} in ${layoutPath}.`);
    }
    files[id] = { x: entry.x, y: entry.y };
  }
  return { version: 1, groups, files };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
