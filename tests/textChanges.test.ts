import { describe, expect, it } from 'vitest';
import { findChangedLineRange } from '../src/state/textChanges';

describe('changed line range detection', () => {
  it('finds the smallest changed region for an external edit', () => {
    expect(findChangedLineRange(
      'one\ntwo\nthree\nfour',
      'one\nTWO\nTHREE\nfour'
    )).toEqual({ startLine: 1, endLine: 2 });
  });

  it('returns no range for an unchanged watcher notification', () => {
    expect(findChangedLineRange('same\ntext', 'same\ntext')).toBeUndefined();
  });
});
