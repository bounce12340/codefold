import { describe, expect, it } from 'vitest';
import { AnnotationSaveTracker } from '../src/webview2d/annotationSaveTracker';

describe('annotation save tracking', () => {
  it('blocks a second save while preserving a newer draft across selection changes', () => {
    const tracker = new AnnotationSaveTracker();

    tracker.setDraft('src/a.ts', 'first version');
    expect(tracker.begin('src/a.ts', 'first version')).toBe(true);
    tracker.setDraft('src/a.ts', 'newer draft');

    expect(tracker.isPending('src/a.ts')).toBe(true);
    expect(tracker.hasNewerPendingDraft('src/a.ts')).toBe(true);
    expect(tracker.begin('src/a.ts', 'newer draft')).toBe(false);
    expect(tracker.finish('src/a.ts', 'first version')).toEqual({
      hasNewerDraft: true
    });
    expect(tracker.hasDraft('src/a.ts')).toBe(true);

    expect(tracker.begin('src/a.ts', 'newer draft')).toBe(true);
    expect(tracker.finish('src/a.ts', 'newer draft')).toEqual({
      hasNewerDraft: false
    });
    expect(tracker.hasDraft('src/a.ts')).toBe(false);
  });

  it('allows a failed save to be retried without discarding the draft', () => {
    const tracker = new AnnotationSaveTracker();
    tracker.setDraft('src/a.ts', 'retry me');
    expect(tracker.begin('src/a.ts', 'retry me')).toBe(true);

    tracker.fail('src/a.ts');

    expect(tracker.isPending('src/a.ts')).toBe(false);
    expect(tracker.hasDraft('src/a.ts')).toBe(true);
    expect(tracker.begin('src/a.ts', 'retry me')).toBe(true);
  });
});
