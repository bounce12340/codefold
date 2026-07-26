import type { AgentInfo, AgentSnapshot } from '../scanner/model';
import type { AgentHookEvent } from './events';

const badgeShapes = ['diamond', 'hexagon', 'triangle', 'square'] as const;
const badgeTones = ['violet', 'magenta', 'copper'] as const;

interface AgentRecord {
  info: AgentInfo;
  workAreas: Set<string>;
}

export class AgentRegistry {
  private readonly records = new Map<string, AgentRecord>();

  apply(event: AgentHookEvent, workArea?: string): void {
    if (event.type === 'agent_spawn') {
      this.ensure(event.parent_agent_id);
      const child = this.ensure(event.agent_id, event.agent_name);
      child.info.parentId = event.parent_agent_id;
      child.info.status = 'active';
      return;
    }

    const agent = this.ensure(event.agent_id, event.agent_name);
    if (event.type === 'agent_edit_start') {
      agent.info.status = 'active';
      if (workArea) {
        agent.workAreas.add(workArea);
      }
      return;
    }
    if (event.type === 'agent_edit_end') {
      if (workArea) {
        agent.workAreas.delete(workArea);
      }
      agent.info.status = agent.workAreas.size > 0 ? 'active' : 'idle';
      return;
    }
    if (event.type === 'agent_done') {
      agent.workAreas.clear();
      agent.info.status = 'done';
      return;
    }

    agent.info.status = 'active';
  }

  snapshots(): AgentSnapshot[] {
    return [...this.records.values()]
      .map(({ info, workAreas }) => ({
        ...info,
        workAreas: [...workAreas].sort()
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  private ensure(id: string, name?: string): AgentRecord {
    const existing = this.records.get(id);
    if (existing) {
      if (name) {
        existing.info.name = name;
      }
      return existing;
    }

    const ordinal = this.records.size;
    const record: AgentRecord = {
      info: {
        id,
        name: name || id,
        parentId: null,
        badge: `${badgeShapes[ordinal % badgeShapes.length]}-${badgeTones[ordinal % badgeTones.length]}`,
        status: 'idle'
      },
      workAreas: new Set()
    };
    this.records.set(id, record);
    return record;
  }
}
