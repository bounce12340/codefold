import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { extract2dTemplate, renderPreviewHtml } from '../tools/preview/build.mjs';

const root = path.resolve(import.meta.dirname, '..');

// Rendered from src/extension.ts through the same helper the build uses, so
// these assertions hold on a tree that has never been built. Reading the
// generated tools/preview/index.html instead would fail spuriously whenever
// src/extension.ts changed without a rebuild.
let extensionSource: string;
let previewHtml: string;

beforeAll(async () => {
  extensionSource = await readFile(path.join(root, 'src', 'extension.ts'), 'utf8');
  previewHtml = renderPreviewHtml(extensionSource);
});

describe('browser preview harness generation', () => {
  it('contains the product 2D style block byte-for-byte from extension.ts', () => {
    const template = extract2dTemplate(extensionSource);
    const styleStart = template.indexOf('<style nonce="${nonce}">');
    const styleEnd = template.indexOf('</style>', styleStart) + '</style>'.length;
    expect(styleStart).toBeGreaterThanOrEqual(0);
    expect(styleEnd).toBeGreaterThan(styleStart);
    const expectedStyle = template
      .slice(styleStart, styleEnd)
      .replaceAll('${nonce}', 'codefold-preview');

    expect(previewHtml).toContain(expectedStyle);
  });

  it('loads the preview stub before the real dist webview bundle', () => {
    const stubIndex = previewHtml.indexOf('src="./preview.js"');
    const productIndex = previewHtml.indexOf('src="../../dist/webview2d.js"');

    expect(stubIndex).toBeGreaterThanOrEqual(0);
    expect(productIndex).toBeGreaterThan(stubIndex);
    expect(previewHtml).toContain('id="canvas"');
    expect(previewHtml).toContain('id="agent-tree"');
  });

  it('marks the generated harness as build output rather than a source file', () => {
    expect(previewHtml.startsWith('<!-- Generated from src/extension.ts')).toBe(true);
    expect(previewHtml).toContain('<title>CodeFold Preview</title>');
  });

  it('contains a product CSS override that stops flashes when disabled', () => {
    const template = extract2dTemplate(extensionSource);

    expect(template).toMatch(
      /body\.flash-disabled[\s\S]+?node-state-error[\s\S]+?animation:\s*none\s*!important;/
    );
  });
});
