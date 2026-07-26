import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type WorkspaceNotes = Record<string, string>;

const NOTES_DIRECTORY = '.codefold';
const NOTES_FILE = 'notes.json';

export async function readWorkspaceNotes(
  workspaceRoot: string
): Promise<WorkspaceNotes> {
  const notesPath = path.join(workspaceRoot, NOTES_DIRECTORY, NOTES_FILE);
  let source: string;
  try {
    source = await readFile(notesPath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return {};
    }
    throw new Error(`Could not read ${notesPath}: ${formatError(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`Could not parse ${notesPath}: ${formatError(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${notesPath} must contain a JSON object keyed by relative path.`);
  }

  const notes: WorkspaceNotes = {};
  for (const [filePath, note] of Object.entries(parsed)) {
    if (typeof note !== 'string') {
      throw new Error(`Note for ${filePath} in ${notesPath} must be a string.`);
    }
    notes[normalizeRelativePath(filePath)] = note;
  }
  return notes;
}

export async function writeWorkspaceNote(
  workspaceRoot: string,
  relativePath: string,
  manual: string
): Promise<string | null> {
  const notes = await readWorkspaceNotes(workspaceRoot);
  const normalizedPath = normalizeRelativePath(relativePath);
  const normalizedManual = manual.trim().length === 0 ? null : manual;

  if (normalizedManual === null) {
    delete notes[normalizedPath];
  } else {
    notes[normalizedPath] = normalizedManual;
  }

  const notesDirectory = path.join(workspaceRoot, NOTES_DIRECTORY);
  await mkdir(notesDirectory, { recursive: true });
  await writeFile(
    path.join(notesDirectory, NOTES_FILE),
    `${JSON.stringify(notes, null, 2)}\n`,
    'utf8'
  );
  return normalizedManual;
}

function normalizeRelativePath(filePath: string): string {
  return filePath.replaceAll('\\', '/').replace(/^\.\//, '');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
