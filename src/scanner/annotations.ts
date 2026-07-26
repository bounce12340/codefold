import path from 'node:path';

const JAVASCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);

export function extractFileAnnotation(
  filePath: string,
  source: string
): string | null {
  const extension = path.posix.extname(filePath.replaceAll('\\', '/')).toLowerCase();
  const withoutBom = source.replace(/^\uFEFF/, '');

  if (JAVASCRIPT_EXTENSIONS.has(extension)) {
    return firstSentence(extractJavaScriptHeaderComment(withoutBom));
  }
  if (extension === '.py') {
    return firstSentence(
      extractPythonModuleDocstring(withoutBom)
      ?? extractPythonHeaderComment(withoutBom)
    );
  }
  return null;
}

function extractJavaScriptHeaderComment(source: string): string | null {
  const header = source.trimStart();
  const docBlock = /^\/\*\*([\s\S]*?)\*\//.exec(header);
  if (docBlock?.[1] !== undefined) {
    return docBlock[1]
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*\*?\s?/, ''))
      .join(' ');
  }
  if (!header.startsWith('//')) {
    return null;
  }

  const lines: string[] = [];
  for (const line of header.split(/\r?\n/)) {
    const match = /^\s*\/\/\/?\s?(.*)$/.exec(line);
    if (match?.[1] === undefined) {
      break;
    }
    lines.push(match[1]);
  }
  return lines.join(' ');
}

function extractPythonModuleDocstring(source: string): string | null {
  const lines = source.split(/\r?\n/);
  let lineIndex = 0;
  while (lineIndex < lines.length) {
    const trimmed = lines[lineIndex].trim();
    if (
      trimmed === ''
      || trimmed.startsWith('#!')
      || /^#.*coding[:=]\s*[-\w.]+/.test(trimmed)
      || trimmed.startsWith('#')
    ) {
      lineIndex += 1;
      continue;
    }
    break;
  }

  const possibleDocstring = lines.slice(lineIndex).join('\n');
  const match = /^\s*(?:[rRuU]{0,2})?("""|''')([\s\S]*?)\1/.exec(possibleDocstring);
  return match?.[2] ?? null;
}

function extractPythonHeaderComment(source: string): string | null {
  const lines = source.split(/\r?\n/);
  const comments: string[] = [];
  let started = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!started && (
      trimmed === ''
      || trimmed.startsWith('#!')
      || /^#.*coding[:=]\s*[-\w.]+/.test(trimmed)
    )) {
      continue;
    }
    const match = /^\s*#(?![!])\s?(.*)$/.exec(line);
    if (match?.[1] === undefined) {
      break;
    }
    started = true;
    comments.push(match[1]);
  }
  return comments.length > 0 ? comments.join(' ') : null;
}

function firstSentence(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) {
    return null;
  }
  const sentence = /^.*?[.!?。！？](?=\s|$)/u.exec(normalized);
  return sentence?.[0] ?? normalized;
}
