import { describe, expect, it } from 'vitest';
import { AgentRegistry } from '../src/agents/agentRegistry';

describe('agent registry', () => {
  it('builds a parent-child hierarchy from agent_spawn', () => {
    const registry = new AgentRegistry();
    registry.apply({
      type: 'agent_spawn',
      agent_id: 'worker-1',
      agent_name: 'worker one',
      parent_agent_id: 'main'
    });
    registry.apply({
      type: 'agent_edit_start',
      agent_id: 'worker-1',
      path: 'src/a.ts'
    }, 'src/a.ts#run');

    const agents = registry.snapshots();
    expect(agents.find((agent) => agent.id === 'main')).toMatchObject({
      parentId: null,
      status: 'idle'
    });
    expect(agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      name: 'worker one',
      parentId: 'main',
      status: 'active',
      workAreas: ['src/a.ts#run']
    });
  });

  it('assigns distinct shape and auxiliary-tone badge descriptors', () => {
    const registry = new AgentRegistry();
    registry.apply({ type: 'agent_done', agent_id: 'a' });
    registry.apply({ type: 'agent_done', agent_id: 'b' });

    const [first, second] = registry.snapshots();
    expect(first.badge).not.toBe(second.badge);
    expect(first.badge).toMatch(/^(diamond|hexagon|triangle|square)-(violet|magenta|copper)$/);
  });
});
