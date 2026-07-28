import type { GraphNode, NodeState } from '../scanner/model';

export const EDITING_DEBOUNCE_MS = 2_000;

export interface NodeSignals {
  error: boolean;
  editing: boolean;
  dirty: boolean;
  verifying: boolean;
  passing: boolean;
}

interface InternalSignals {
  errorSources: Set<GraphNode['errorSources'][number]>;
  editingAgents: Set<string>;
  humanEditing: boolean;
  dirty: boolean;
  verifying: boolean;
  passing: boolean;
  debounceTimer?: ReturnType<typeof setTimeout>;
}

export function resolveNodeState(signals: NodeSignals): NodeState {
  if (signals.error) {
    return 'error';
  }
  if (signals.editing) {
    return 'editing';
  }
  if (signals.dirty) {
    return 'dirty';
  }
  if (signals.verifying) {
    return 'verifying';
  }
  if (signals.passing) {
    return 'passing';
  }
  return 'idle';
}

export function hasAgentConflict(
  node: Pick<GraphNode, 'editingAgents'>
): boolean {
  return new Set(node.editingAgents).size > 1;
}

export class NodeStateStore {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly signals = new Map<string, InternalSignals>();

  constructor(
    nodes: readonly GraphNode[],
    private readonly onChange: (nodes: GraphNode[]) => void = () => undefined
  ) {
    for (const node of nodes) {
      this.nodes.set(node.id, node);
      this.signals.set(node.id, {
        errorSources: new Set(node.errorSources),
        editingAgents: new Set(node.editingAgents),
        humanEditing: node.state === 'editing' && node.editingAgents.length === 0,
        dirty: node.state === 'dirty',
        verifying: node.state === 'verifying',
        passing: node.state === 'passing'
      });
    }
  }

  markFileChange(nodeIds: readonly string[]): void {
    this.update(nodeIds, (signals, nodeId) => {
      signals.humanEditing = true;
      signals.dirty = false;
      signals.verifying = false;
      signals.passing = false;
      if (signals.debounceTimer) {
        clearTimeout(signals.debounceTimer);
      }
      signals.debounceTimer = setTimeout(() => {
        const current = this.signals.get(nodeId);
        if (!current) {
          return;
        }
        current.humanEditing = false;
        current.dirty = true;
        current.debounceTimer = undefined;
        this.syncAndEmit([nodeId]);
      }, EDITING_DEBOUNCE_MS);
    });
  }

  startAgentEdit(nodeIds: readonly string[], agentId: string): void {
    this.update(nodeIds, (signals) => {
      signals.editingAgents.add(agentId);
      signals.dirty = false;
      signals.verifying = false;
      signals.passing = false;
    });
  }

  endAgentEdit(nodeIds: readonly string[], agentId: string): void {
    this.update(nodeIds, (signals) => {
      signals.editingAgents.delete(agentId);
      if (!signals.humanEditing && signals.editingAgents.size === 0) {
        signals.dirty = true;
      }
    });
  }

  finishAgent(agentId: string): void {
    const changed: string[] = [];
    for (const [nodeId, signals] of this.signals) {
      if (!signals.editingAgents.delete(agentId)) {
        continue;
      }
      if (!signals.humanEditing && signals.editingAgents.size === 0) {
        signals.dirty = true;
      }
      changed.push(nodeId);
    }
    this.syncAndEmit(changed);
  }

  setVerifying(nodeIds: readonly string[]): void {
    this.update(nodeIds, (signals) => {
      signals.dirty = false;
      signals.verifying = true;
      signals.passing = false;
    });
  }

  setPassing(nodeIds: readonly string[]): void {
    this.update(nodeIds, (signals) => {
      signals.dirty = false;
      signals.verifying = false;
      signals.passing = true;
    });
  }

  addError(
    nodeIds: readonly string[],
    source: GraphNode['errorSources'][number]
  ): void {
    this.update(nodeIds, (signals) => {
      signals.errorSources.add(source);
    });
  }

  clearError(
    nodeIds: readonly string[],
    source?: GraphNode['errorSources'][number]
  ): void {
    this.update(nodeIds, (signals) => {
      if (source) {
        signals.errorSources.delete(source);
      } else {
        signals.errorSources.clear();
      }
    });
  }

  replaceErrorSource(
    source: GraphNode['errorSources'][number],
    activeNodeIds: readonly string[]
  ): void {
    const active = new Set(activeNodeIds);
    const changed: string[] = [];
    for (const [nodeId, signals] of this.signals) {
      const shouldHaveSource = active.has(nodeId);
      if (signals.errorSources.has(source) === shouldHaveSource) {
        continue;
      }
      if (shouldHaveSource) {
        signals.errorSources.add(source);
      } else {
        signals.errorSources.delete(source);
      }
      changed.push(nodeId);
    }
    this.syncAndEmit(changed);
  }

  dispose(): void {
    for (const signals of this.signals.values()) {
      if (signals.debounceTimer) {
        clearTimeout(signals.debounceTimer);
      }
    }
  }

  private update(
    nodeIds: readonly string[],
    change: (signals: InternalSignals, nodeId: string) => void
  ): void {
    const changed: string[] = [];
    for (const nodeId of new Set(nodeIds)) {
      const signals = this.signals.get(nodeId);
      if (!signals) {
        continue;
      }
      change(signals, nodeId);
      changed.push(nodeId);
    }
    this.syncAndEmit(changed);
  }

  private syncAndEmit(nodeIds: readonly string[]): void {
    const changed: GraphNode[] = [];
    for (const nodeId of nodeIds) {
      const node = this.nodes.get(nodeId);
      const signals = this.signals.get(nodeId);
      if (!node || !signals) {
        continue;
      }
      node.errorSources = [...signals.errorSources];
      node.editingAgents = [...signals.editingAgents].sort();
      node.state = resolveNodeState({
        error: signals.errorSources.size > 0,
        editing: signals.humanEditing || signals.editingAgents.size > 0,
        dirty: signals.dirty,
        verifying: signals.verifying,
        passing: signals.passing
      });
      changed.push({
        ...node,
        errorSources: [...node.errorSources],
        editingAgents: [...node.editingAgents],
        annotation: { ...node.annotation },
        range: { ...node.range }
      });
    }
    if (changed.length > 0) {
      this.onChange(changed);
    }
  }
}
