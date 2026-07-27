import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // webview2d.dom.test.ts opts into happy-dom with a per-file control comment.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      reporter: ['text']
    }
  }
});
