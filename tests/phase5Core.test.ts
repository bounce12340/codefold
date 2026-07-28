import { describe, expect, it } from 'vitest';
import { AgentRegistry } from '../src/agents/agentRegistry';
import { AgentReportTracker } from '../src/agents/agentReportTracker';
import type { AgentSnapshot, GraphNode } from '../src/scanner/model';
import { NodeStateStore } from '../src/state/nodeStateMachine';
import {
  computeStatusSummary,
  formatStatusSummary
} from '../src/state/statusSummary';

describe('Phase 5 agent reports and summary', () => {
  it('turns an agent_report into an agent error with attribution and message', () => {
    const nodes = [node('src/panel.ts'), node('src/panel.ts#renderPanel')];
    const store = new NodeStateStore(nodes);
    const reports = new AgentReportTracker(store);
    const registry = new AgentRegistry();
    registry.apply({
      type: 'agent_edit_start',
      agent_id: 'reviewer',
      agent_name: 'Review agent',
      node_id: 'src/panel.ts#renderPanel'
    }, 'src/panel.ts#renderPanel');

    reports.apply({
      type: 'agent_report',
      agent_id: 'reviewer',
      node_id: 'src/panel.ts#renderPanel',
      message: 'Null payload reaches renderPanel.'
    }, nodes.map((candidate) => candidate.id), registry.snapshots());

    expect(nodes.map((candidate) => candidate.state)).toEqual(['error', 'error']);
    expect(nodes[1].errorSources).toEqual(['agent']);
    expect(reports.snapshot()['src/panel.ts#renderPanel']).toEqual([
      expect.objectContaining({
        agentId: 'reviewer',
        agentName: 'Review agent',
        message: 'Null payload reaches renderPanel.',
        fileId: 'src/panel.ts',
        nodeId: 'src/panel.ts#renderPanel'
      })
    ]);
  });

  it('coexists with three other error sources and resolves only agent reports', () => {
    const nodes = [node('src/panel.ts')];
    const store = new NodeStateStore(nodes);
    const reports = new AgentReportTracker(store);
    store.addError([nodes[0].id], 'diagnostic');
    store.addError([nodes[0].id], 'test');
    store.addError([nodes[0].id], 'runtime');

    reports.apply({
      type: 'agent_report',
      agent_id: 'reviewer',
      path: 'src/panel.ts',
      message: 'Potential race.',
      level: 'error'
    }, [nodes[0].id], []);
    expect(new Set(nodes[0].errorSources)).toEqual(new Set([
      'diagnostic',
      'test',
      'runtime',
      'agent'
    ]));

    reports.apply({
      type: 'agent_report',
      agent_id: 'reviewer',
      path: 'src/panel.ts',
      message: 'Potential race resolved.',
      level: 'info'
    }, [nodes[0].id], []);

    expect(nodes[0].state).toBe('error');
    expect(new Set(nodes[0].errorSources)).toEqual(new Set([
      'diagnostic',
      'test',
      'runtime'
    ]));
    expect(reports.snapshot()).toEqual({});
  });

  it('counts active agents, editing nodes, errors, and passing nodes', () => {
    const editing = node('src/editing.ts');
    editing.state = 'editing';
    editing.editingAgents = ['main'];
    const editingWithError = node('src/conflicted.ts');
    editingWithError.state = 'error';
    editingWithError.editingAgents = ['worker'];
    editingWithError.errorSources = ['agent'];
    const passing = node('src/passing.ts');
    passing.state = 'passing';
    const agents = [
      agent('main', 'active'),
      agent('worker', 'active'),
      agent('done', 'done')
    ];

    const summary = computeStatusSummary(
      [editing, editingWithError, passing],
      agents
    );

    expect(summary).toEqual({
      activeAgents: 2,
      editingNodes: 2,
      errorNodes: 1,
      passingNodes: 1
    });
    expect(formatStatusSummary(summary)).toBe(
      '2 agents active · 2 editing · 1 errors · 1 passing'
    );
  });

  it('removes a finished agent from node edit ownership', () => {
    const nodes = [node('src/panel.ts')];
    const store = new NodeStateStore(nodes);
    const registry = new AgentRegistry();
    registry.apply({
      type: 'agent_edit_start',
      agent_id: 'worker',
      path: 'src/panel.ts'
    }, 'src/panel.ts');
    store.startAgentEdit([nodes[0].id], 'worker');

    registry.apply({ type: 'agent_done', agent_id: 'worker' });
    store.finishAgent('worker');

    expect(nodes[0].editingAgents).toEqual([]);
    expect(nodes[0].state).toBe('dirty');
    expect(registry.snapshots()[0]).toMatchObject({
      id: 'worker',
      status: 'done',
      workAreas: []
    });
  });
});

function node(id: string): GraphNode {
  const fileId = id.split('#')[0];
  return {
    id,
    kind: id.includes('#') ? 'function' : 'file',
    path: fileId,
    name: id.split('#').at(-1) ?? id,
    range: { startLine: 0, endLine: 20 },
    lang: 'ts',
    state: 'idle',
    errorSources: [],
    editingAgents: [],
    annotation: { auto: null, manual: null },
    lastVerifiedAt: null
  };
}

function agent(
  id: string,
  status: 'active' | 'idle' | 'done'
): AgentSnapshot {
  return {
    id,
    name: id,
    parentId: null,
    badge: 'diamond-violet',
    status,
    workAreas: []
  };
}
