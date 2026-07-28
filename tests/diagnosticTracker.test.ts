import { describe, expect, it } from 'vitest';
import type { GraphNode } from '../src/scanner/model';
import {
  DiagnosticTracker,
  mapDiagnosticsToNodes,
  type DiagnosticInput
} from '../src/diagnostics/diagnosticTracker';
import { NodeStateStore } from '../src/state/nodeStateMachine';

describe('diagnostic tracking', () => {
  it('turns Error diagnostics red while Warning and lower severities do not', () => {
    const file = node('src/panel.ts', 'file', 0, 100);
    const store = new NodeStateStore([file]);
    const tracker = new DiagnosticTracker([file], store);

    tracker.apply([diagnostic('warning', 12)]);
    expect(file.state).toBe('idle');
    expect(file.errorSources).toEqual([]);
    expect(tracker.snapshot()[file.id]?.[0]?.severity).toBe('warning');

    tracker.apply([diagnostic('error', 12)]);
    expect(file.state).toBe('error');
    expect(file.errorSources).toEqual(['diagnostic']);
  });

  it('clears only the diagnostic source when diagnostics disappear', () => {
    const file = node('src/panel.ts', 'file', 0, 100);
    const store = new NodeStateStore([file]);
    const tracker = new DiagnosticTracker([file], store);

    tracker.apply([diagnostic('error', 12)]);
    tracker.apply([]);
    expect(file.state).toBe('idle');
    expect(file.errorSources).toEqual([]);
  });

  it('keeps a node red when another error source remains', () => {
    const file = node('src/panel.ts', 'file', 0, 100);
    const store = new NodeStateStore([file]);
    const tracker = new DiagnosticTracker([file], store);

    store.addError([file.id], 'runtime');
    tracker.apply([diagnostic('error', 12)]);
    tracker.apply([]);
    expect(file.state).toBe('error');
    expect(file.errorSources).toEqual(['runtime']);
  });

  it('maps a diagnostic line range to its file and overlapping function', () => {
    const file = node('src/panel.ts', 'file', 0, 100);
    const first = node('src/panel.ts#render', 'function', 10, 20);
    const second = node('src/panel.ts#save', 'function', 30, 40);

    const mapping = mapDiagnosticsToNodes(
      [file, first, second],
      [diagnostic('error', 16)]
    );

    expect(mapping.errorNodeIds).toEqual([file.id, first.id]);
    expect(mapping.diagnostics[first.id]?.[0]).toMatchObject({
      source: 'ts',
      message: 'Type mismatch',
      severity: 'error'
    });
    expect(mapping.diagnostics[second.id]).toBeUndefined();
  });

  it('keeps error above editing and restores editing after diagnostic clear', () => {
    const file = node('src/panel.ts', 'file', 0, 100);
    const store = new NodeStateStore([file]);
    const tracker = new DiagnosticTracker([file], store);

    store.startAgentEdit([file.id], 'agent-a');
    tracker.apply([diagnostic('error', 12)]);
    expect(file.state).toBe('error');
    expect(file.editingAgents).toEqual(['agent-a']);
    expect(file.errorSources).toEqual(['diagnostic']);

    tracker.apply([]);
    expect(file.state).toBe('editing');
    expect(file.editingAgents).toEqual(['agent-a']);
  });
});

function node(
  id: string,
  kind: GraphNode['kind'],
  startLine: number,
  endLine: number
): GraphNode {
  return {
    id,
    kind,
    path: 'src/panel.ts',
    name: id.split('#').at(-1) ?? 'panel.ts',
    range: { startLine, endLine },
    lang: 'ts',
    state: 'idle',
    errorSources: [],
    editingAgents: [],
    annotation: { auto: null, manual: null },
    lastVerifiedAt: null
  };
}

function diagnostic(
  severity: DiagnosticInput['severity'],
  line: number
): DiagnosticInput {
  return {
    fileId: 'src/panel.ts',
    source: 'ts',
    message: 'Type mismatch',
    severity,
    range: {
      startLine: line,
      startCharacter: 3,
      endLine: line,
      endCharacter: 8
    }
  };
}
