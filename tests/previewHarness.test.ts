import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extract2dTemplate } from '../tools/preview/build.mjs';

const root = path.resolve(import.meta.dirname, '..');

describe('browser preview harness generation', () => {
  it('contains the product 2D style block byte-for-byte from extension.ts', async () => {
    const [extensionSource, previewHtml] = await Promise.all([
      readFile(path.join(root, 'src', 'extension.ts'), 'utf8'),
      readFile(path.join(root, 'tools', 'preview', 'index.html'), 'utf8')
    ]);
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

  it('loads the preview stub before the real dist webview bundle', async () => {
    const previewHtml = await readFile(
      path.join(root, 'tools', 'preview', 'index.html'),
      'utf8'
    );
    const stubIndex = previewHtml.indexOf('src="./preview.js"');
    const productIndex = previewHtml.indexOf('src="../../dist/webview2d.js"');

    expect(stubIndex).toBeGreaterThanOrEqual(0);
    expect(productIndex).toBeGreaterThan(stubIndex);
    expect(previewHtml).toContain('id="canvas"');
    expect(previewHtml).toContain('id="agent-tree"');
  });
});
