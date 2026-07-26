import { describe, expect, it } from 'vitest';
import { extractFileAnnotation } from '../src/scanner/annotations';

describe('file annotation extraction', () => {
  it('extracts the first sentence from a TypeScript header comment', () => {
    expect(
      extractFileAnnotation(
        'src/index.ts',
        '// Builds the workspace graph. More implementation detail follows.\nexport const graph = {};'
      )
    ).toBe('Builds the workspace graph.');
  });

  it('extracts JSDoc-style JavaScript header comments', () => {
    expect(
      extractFileAnnotation(
        'src/index.js',
        '/**\n * Starts the browser view.\n * Extra context is not part of the summary.\n */\nexport {};'
      )
    ).toBe('Starts the browser view.');
  });

  it('extracts the first sentence from a Python module docstring', () => {
    expect(
      extractFileAnnotation(
        'python/app.py',
        '"""Loads the fixture package. The rest stays out of the label."""\nfrom . import helpers'
      )
    ).toBe('Loads the fixture package.');
  });

  it('falls back to a Python file-header comment', () => {
    expect(
      extractFileAnnotation(
        'python/helpers.py',
        '# Provides fixture helpers. More details follow.\nanswer = 42'
      )
    ).toBe('Provides fixture helpers.');
  });

  it('returns null when a supported file has no header annotation', () => {
    expect(
      extractFileAnnotation('src/plain.ts', 'export const plain = true;\n')
    ).toBeNull();
  });
});
