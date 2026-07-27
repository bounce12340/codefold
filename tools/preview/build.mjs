import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const previewDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(previewDirectory, '..', '..');
const nonce = 'codefold-preview';
const productScriptUri = '../../dist/webview2d.js';
const previewScriptUri = './preview.js';

export async function buildPreviewHarness(rootDirectory = defaultRoot) {
  const extensionPath = path.join(rootDirectory, 'src', 'extension.ts');
  const outputPath = path.join(rootDirectory, 'tools', 'preview', 'index.html');
  const extensionSource = await readFile(extensionPath, 'utf8');
  const template = extract2dTemplate(extensionSource);
  const placeholders = [...template.matchAll(/\$\{([A-Za-z_$][\w$]*)\}/g)]
    .map((match) => match[1]);
  const unexpected = [...new Set(placeholders)]
    .filter((name) => name !== 'nonce' && name !== 'scriptUri');
  if (unexpected.length > 0) {
    throw new Error(
      `Preview extraction found unsupported 2D HTML placeholders: ${unexpected.join(', ')}`
    );
  }
  if (!placeholders.includes('nonce') || !placeholders.includes('scriptUri')) {
    throw new Error('Preview extraction could not find nonce and scriptUri placeholders.');
  }

  let html = template
    .replaceAll('${nonce}', nonce)
    .replaceAll('${scriptUri}', productScriptUri);
  const productTag = `<script nonce="${nonce}" src="${productScriptUri}"></script>`;
  if (countOccurrences(html, productTag) !== 1) {
    throw new Error('Preview extraction expected exactly one product webview script tag.');
  }
  html = html.replace(
    productTag,
    `<script nonce="${nonce}" src="${previewScriptUri}"></script>\n  ${productTag}`
  );
  html = html.replace('<title>CodeFold</title>', '<title>CodeFold Preview</title>');
  await writeFile(
    outputPath,
    '<!-- Generated from src/extension.ts by tools/preview/build.mjs. Do not hand-edit. -->\n'
      + html,
    'utf8'
  );
  return outputPath;
}

export function extract2dTemplate(extensionSource) {
  const functionStart = extensionSource.indexOf('function get2dWebviewHtml(');
  const nextFunction = extensionSource.indexOf(
    'function get3dWebviewHtml(',
    functionStart
  );
  if (functionStart < 0 || nextFunction < 0) {
    throw new Error('Could not locate the 2D webview HTML function boundaries.');
  }
  const functionSource = extensionSource.slice(functionStart, nextFunction);
  const returnMarker = 'return `';
  const templateStart = functionSource.indexOf(returnMarker);
  const templateEnd = functionSource.lastIndexOf('`;');
  if (templateStart < 0 || templateEnd <= templateStart) {
    throw new Error('Could not locate the 2D webview template literal.');
  }
  return functionSource.slice(templateStart + returnMarker.length, templateEnd);
}

function countOccurrences(value, search) {
  return value.split(search).length - 1;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (invokedPath === import.meta.url) {
  const outputPath = await buildPreviewHarness();
  console.log(`Generated ${path.relative(defaultRoot, outputPath)}.`);
}
