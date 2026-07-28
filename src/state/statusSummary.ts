import type {
  AgentSnapshot,
  GraphNode,
  StatusSummary
} from '../scanner/model';

export function computeStatusSummary(
  nodes: readonly GraphNode[],
  agents: readonly AgentSnapshot[]
): StatusSummary {
  return {
    activeAgents: agents.filter((agent) => agent.status === 'active').length,
    editingNodes: nodes.filter((node) =>
      node.state === 'editing' || node.editingAgents.length > 0
    ).length,
    errorNodes: nodes.filter((node) => node.state === 'error').length,
    passingNodes: nodes.filter((node) => node.state === 'passing').length
  };
}

export function formatStatusSummary(summary: StatusSummary): string {
  return `${summary.activeAgents} agents active · `
    + `${summary.editingNodes} editing · `
    + `${summary.errorNodes} errors · `
    + `${summary.passingNodes} passing`;
}
