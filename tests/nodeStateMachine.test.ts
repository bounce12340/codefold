import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GraphNode } from '../src/scanner/model';
import {
  EDITING_DEBOUNCE_MS,
  hasAgentConflict,
  NodeStateStore,
  resolveNodeState
} from '../src/state/nodeStateMachine';

function node(id = 'src/a.ts'): GraphNode {
  return {
    id,
    kind: id.includes('#') ? 'function' : 'file',
    path: 'src/a.ts',
    name: 'a.ts',
    range: { startLine: 0, endLine: 10 },
    lang: 'ts',
    state: 'idle',
    errorSources: [],
    editingAgents: [],
    annotation: { auto: null, manual: null },
    lastVerifiedAt: null
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('node state machine', () => {
  it('debounces file changes for two seconds before becoming dirty', () => {
    vi.useFakeTimers();
    const target = node();
    const store = new NodeStateStore([target]);

    store.markFileChange([target.id]);
    expect(target.state).toBe('editing');
    expect(target.editingAgents).toEqual([]);

    vi.advanceTimersByTime(1_500);
    store.markFileChange([target.id]);
    vi.advanceTimersByTime(1_999);
    expect(target.state).toBe('editing');

    vi.advanceTimersByTime(1);
    expect(target.state).toBe('dirty');
    expect(EDITING_DEBOUNCE_MS).toBe(2_000);
    store.dispose();
  });

  it('tracks multiple editing agents and marks a conflict-capable node dirty after both end', () => {
    const target = node('src/a.ts#run');
    const store = new NodeStateStore([target]);

    store.startAgentEdit([target.id], 'agent-a');
    store.startAgentEdit([target.id], 'agent-b');
    expect(target.state).toBe('editing');
    expect(target.editingAgents).toEqual(['agent-a', 'agent-b']);
    expect(hasAgentConflict(target)).toBe(true);

    store.endAgentEdit([target.id], 'agent-a');
    expect(target.state).toBe('editing');
    store.endAgentEdit([target.id], 'agent-b');
    expect(target.state).toBe('dirty');
    expect(hasAgentConflict(target)).toBe(false);
  });

  it('transitions from dirty through verification to passing or error', () => {
    const target = node();
    const store = new NodeStateStore([target]);

    store.startAgentEdit([target.id], 'agent-a');
    store.endAgentEdit([target.id], 'agent-a');
    expect(target.state).toBe('dirty');

    store.setVerifying([target.id]);
    expect(target.state).toBe('verifying');
    store.setPassing([target.id]);
    expect(target.state).toBe('passing');

    store.setVerifying([target.id]);
    store.addError([target.id], 'agent');
    expect(target.state).toBe('error');
    store.startAgentEdit([target.id], 'agent-a');
    expect(target.state).toBe('error');
    store.clearError([target.id], 'agent');
    expect(target.state).toBe('editing');
  });

  it('uses the specified display priority', () => {
    expect(resolveNodeState({
      error: true,
      editing: true,
      dirty: true,
      verifying: true,
      passing: true
    })).toBe('error');
    expect(resolveNodeState({
      error: false,
      editing: true,
      dirty: true,
      verifying: true,
      passing: true
    })).toBe('editing');
    expect(resolveNodeState({
      error: false,
      editing: false,
      dirty: true,
      verifying: true,
      passing: true
    })).toBe('dirty');
    expect(resolveNodeState({
      error: false,
      editing: false,
      dirty: false,
      verifying: true,
      passing: true
    })).toBe('verifying');
    expect(resolveNodeState({
      error: false,
      editing: false,
      dirty: false,
      verifying: false,
      passing: true
    })).toBe('passing');
    expect(resolveNodeState({
      error: false,
      editing: false,
      dirty: false,
      verifying: false,
      passing: false
    })).toBe('idle');
  });
});
