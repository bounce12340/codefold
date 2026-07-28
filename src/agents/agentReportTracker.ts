import type { AgentReportEvent } from './events';
import type {
  AgentReportDetail,
  AgentSnapshot,
  NodeAgentReports
} from '../scanner/model';
import { NodeStateStore } from '../state/nodeStateMachine';

export class AgentReportTracker {
  private readonly reports = new Map<string, Map<string, AgentReportDetail>>();

  constructor(private readonly stateStore: NodeStateStore) {}

  apply(
    event: AgentReportEvent,
    nodeIds: readonly string[],
    agents: readonly AgentSnapshot[]
  ): void {
    const agentName = event.agent_name
      ?? agents.find((agent) => agent.id === event.agent_id)?.name
      ?? event.agent_id;
    for (const nodeId of new Set(nodeIds)) {
      const reportsByAgent = this.reports.get(nodeId) ?? new Map();
      if (event.level !== 'info') {
        const fileId = nodeId.includes('#') ? nodeId.slice(0, nodeId.indexOf('#')) : nodeId;
        reportsByAgent.set(event.agent_id, {
          id: `${nodeId}\0${event.agent_id}`,
          agentId: event.agent_id,
          agentName,
          message: event.message,
          fileId,
          nodeId,
          createdAt: new Date().toISOString()
        });
        this.reports.set(nodeId, reportsByAgent);
      } else {
        reportsByAgent.delete(event.agent_id);
        if (reportsByAgent.size === 0) {
          this.reports.delete(nodeId);
        }
      }
    }
    this.stateStore.replaceErrorSource('agent', [...this.reports.keys()]);
  }

  snapshot(): NodeAgentReports {
    return Object.fromEntries(
      [...this.reports.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([nodeId, reports]) => [
          nodeId,
          [...reports.values()]
            .sort((left, right) => left.agentId.localeCompare(right.agentId))
            .map((report) => ({ ...report }))
        ])
    );
  }
}
