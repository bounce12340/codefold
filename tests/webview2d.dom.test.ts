// @vitest-environment happy-dom

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRegistry } from '../src/agents/agentRegistry';
import type {
  AgentSnapshot,
  GraphNode,
  NodeState,
  NodeStateUpdate,
  WebviewGraph
} from '../src/scanner/model';
import { resolveNodeState } from '../src/state/nodeStateMachine';

const d3Spies = vi.hoisted(() => ({
  forceSimulation: vi.fn()
}));

vi.mock('d3-force', async (importOriginal) => {
  const actual = await importOriginal<typeof import('d3-force')>();
  return {
    ...actual,
    forceSimulation: (...args: Parameters<typeof actual.forceSimulation>) => {
      d3Spies.forceSimulation(...args);
      return actual.forceSimulation(...args);
    }
  };
});

const postedMessages: unknown[] = [];

beforeAll(async () => {
  document.body.innerHTML = webviewShell();
  Object.defineProperty(globalThis, 'acquireVsCodeApi', {
    configurable: true,
    value: () => ({
      postMessage: (message: unknown) => {
        postedMessages.push(message);
      }
    })
  });
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: {
      escape: (value: string) => value.replaceAll('"', '\\"')
    }
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({
      matches: false,
      media: '',
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true
    })
  });
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    value: () => 1
  });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    configurable: true,
    value: () => undefined
  });

  await import('../src/webview2d/main');
  expect(postedMessages).toContainEqual({ type: 'ready' });
});

beforeEach(() => {
  postedMessages.length = 0;
  sendMessage({ type: 'graph', graph: createGraph() });
});

describe('Phase 2 webview DOM rendering', () => {
  it('expands only the folder containing the editing file', () => {
    sendState([nodeState('src/alpha.ts', 'editing')]);

    expect(group('src').classList.contains('expanded')).toBe(true);
    expect(fileCard('src/alpha.ts')).not.toBeNull();
    expect(group('lib').classList.contains('expanded')).toBe(false);
    expect(fileCard('lib/beta.ts')).toBeNull();
  });

  it('keeps every existing group x/y stable and does not rerun force layout', () => {
    const positionsBefore = groupPositions();
    const forceCallsBefore = d3Spies.forceSimulation.mock.calls.length;
    expect(Object.keys(positionsBefore)).toHaveLength(2);
    expect(forceCallsBefore).toBeGreaterThan(0);

    sendState([nodeState('src/alpha.ts', 'editing')]);

    expect(groupPositions()).toEqual(positionsBefore);
    expect(d3Spies.forceSimulation).toHaveBeenCalledTimes(forceCallsBefore);
  });

  it('expands two independently edited modules without moving either group', () => {
    const positionsBefore = groupPositions();
    const agents = [
      agent('agent-a', 'diamond-violet'),
      { ...agent('agent-b', 'hexagon-magenta'), workAreas: ['lib/beta.ts'] }
    ];

    sendState([
      nodeState('src/alpha.ts', 'editing', ['agent-a']),
      nodeState('lib/beta.ts', 'editing', ['agent-b'])
    ], agents);

    expect(group('src').classList.contains('expanded')).toBe(true);
    expect(group('lib').classList.contains('expanded')).toBe(true);
    expect(requiredFileCard('src/alpha.ts').querySelector('.tone-violet')).not.toBeNull();
    expect(requiredFileCard('lib/beta.ts').querySelector('.tone-magenta')).not.toBeNull();
    expect(groupPositions()).toEqual(positionsBefore);
  });

  it('maps every node state to one class and renders the specified priority', () => {
    const stateClasses: NodeState[] = [
      'editing',
      'dirty',
      'error',
      'passing',
      'idle',
      'verifying'
    ];
    for (const state of stateClasses) {
      sendState([nodeState('src/alpha.ts', state)]);
      const card = requiredFileCard('src/alpha.ts');
      expect(card.classList.contains(`node-state-${state}`)).toBe(true);
      expect(
        stateClasses.filter((candidate) =>
          card.classList.contains(`node-state-${candidate}`)
        )
      ).toEqual([state]);
    }

    const prioritized = resolveNodeState({
      error: true,
      editing: true,
      dirty: true,
      verifying: true,
      passing: true
    });
    expect(prioritized).toBe('error');
    sendState([
      nodeState('src/alpha.ts', prioritized, ['agent-a'], ['agent'])
    ], [agent('agent-a', 'diamond-violet')]);
    const card = requiredFileCard('src/alpha.ts');
    expect(card.classList.contains('node-state-error')).toBe(true);
    expect(card.classList.contains('node-state-editing')).toBe(false);
  });

  it('renders one badge per editing agent with distinguishable tones', () => {
    const agents = [
      agent('agent-a', 'diamond-violet'),
      agent('agent-b', 'hexagon-magenta')
    ];
    sendState([nodeState('src/alpha.ts', 'editing', ['agent-a'])], agents);
    expect(requiredFileCard('src/alpha.ts').querySelectorAll('.agent-badge')).toHaveLength(1);
    const agentTree = requiredElement<HTMLUListElement>('agent-tree');
    expect(agentTree.textContent).toContain('agent-a');
    expect(agentTree.querySelector('.agent-work')?.textContent).toBe('src/alpha.ts');

    sendState([
      nodeState('src/alpha.ts', 'editing', ['agent-a', 'agent-b'])
    ], agents);
    const badges = Array.from(
      requiredFileCard('src/alpha.ts').querySelectorAll<HTMLElement>('.agent-badge')
    );
    expect(badges).toHaveLength(2);
    expect(badges.map((badge) =>
      Array.from(badge.classList).find((className) => className.startsWith('tone-'))
    )).toEqual(['tone-violet', 'tone-magenta']);
  });

  it('adds and clears card and sidebar conflict indicators', () => {
    const agents = [
      agent('agent-a', 'diamond-violet'),
      agent('agent-b', 'hexagon-magenta')
    ];
    sendState([
      nodeState('src/alpha.ts', 'editing', ['agent-a', 'agent-b'])
    ], agents);

    expect(requiredFileCard('src/alpha.ts').classList.contains('node-conflict')).toBe(true);
    const conflicts = requiredElement<HTMLElement>('agent-conflicts');
    expect(conflicts.hidden).toBe(false);
    expect(conflicts.textContent).toContain('Potential conflicts: src/alpha.ts');

    sendState([
      nodeState('src/alpha.ts', 'editing', ['agent-a'])
    ], agents);
    expect(requiredFileCard('src/alpha.ts').classList.contains('node-conflict')).toBe(false);
    expect(conflicts.hidden).toBe(true);
    expect(conflicts.textContent).toBe('');
  });

  it('nests a spawned child under the correct parent in the sidebar tree', () => {
    const registry = new AgentRegistry();
    registry.apply({
      type: 'agent_spawn',
      agent_id: 'worker',
      agent_name: 'worker one',
      parent_agent_id: 'main'
    });
    sendState([], registry.snapshots());

    const tree = requiredElement<HTMLUListElement>('agent-tree');
    expect(tree.children).toHaveLength(1);
    const parent = tree.children[0] as HTMLLIElement;
    expect(parent.querySelector(':scope > .agent-line > .agent-name')?.textContent).toBe('main');
    const child = parent.querySelector(':scope > ul > li');
    expect(child?.querySelector(':scope > .agent-line > .agent-name')?.textContent)
      .toBe('worker one');
  });
});

function createGraph(): WebviewGraph {
  const nodes = [
    fileNode('src/alpha.ts', 'alpha.ts'),
    fileNode('lib/beta.ts', 'beta.ts')
  ];
  return {
    nodes,
    edges: [],
    seed: 42,
    truncated: false,
    totalFiles: nodes.length,
    totalFunctions: 0,
    functionCounts: {
      'src/alpha.ts': 0,
      'lib/beta.ts': 0
    },
    layout: {
      version: 1,
      groups: {
        'folder:src': { x: 100, y: 120, expanded: false },
        'folder:lib': { x: 500, y: 220, expanded: false }
      },
      files: {}
    }
  };
}

function fileNode(id: string, name: string): GraphNode {
  return {
    id,
    kind: 'file',
    path: id,
    name,
    range: { startLine: 0, endLine: 20 },
    lang: 'ts',
    state: 'idle',
    errorSources: [],
    editingAgents: [],
    annotation: { auto: null, manual: null },
    lastVerifiedAt: null
  };
}

function nodeState(
  id: string,
  state: NodeState,
  editingAgents: string[] = [],
  errorSources: GraphNode['errorSources'] = []
): GraphNode {
  const name = id.split('/').at(-1) ?? id;
  return {
    ...fileNode(id, name),
    state,
    editingAgents,
    errorSources
  };
}

function agent(id: string, badge: string): AgentSnapshot {
  return {
    id,
    name: id,
    parentId: null,
    badge,
    status: 'active',
    workAreas: ['src/alpha.ts']
  };
}

function sendState(
  nodes: GraphNode[],
  agents: AgentSnapshot[] = []
): void {
  const update: NodeStateUpdate = { nodes, agents };
  sendMessage({ type: 'stateUpdate', update });
}

function sendMessage(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

function group(folder: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    `.folder-group[data-group-id="folder:${folder}"]`
  );
  if (!element) {
    throw new Error(`Missing folder group ${folder}.`);
  }
  return element;
}

function groupPositions(): Record<string, string> {
  return Object.fromEntries(
    Array.from(document.querySelectorAll<HTMLElement>('.folder-group'))
      .map((element) => [
        element.dataset.groupId ?? '',
        element.style.transform
      ])
  );
}

function fileCard(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `.file-card[data-node-id="${id}"]`
  );
}

function requiredFileCard(id: string): HTMLElement {
  const card = fileCard(id);
  if (!card) {
    throw new Error(`Missing file card ${id}.`);
  }
  return card;
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing #${id}.`);
  }
  return element as T;
}

function webviewShell(): string {
  return `
    <main id="canvas">
      <div id="viewport">
        <svg id="edge-layer">
          <defs><marker id="dependency-arrow"></marker></defs>
        </svg>
        <div id="node-layer"></div>
      </div>
    </main>
    <div id="status"></div>
    <div id="warning"></div>
    <div id="layout-warning"></div>
    <div id="tooltip"></div>
    <button id="reset-view"></button>
    <p id="sidebar-empty"></p>
    <div id="node-details"></div>
    <p id="node-name"></p>
    <p id="node-path"></p>
    <p id="node-language"></p>
    <p id="node-state"></p>
    <p id="node-agents"></p>
    <p id="node-errors"></p>
    <div id="node-conflict"></div>
    <p id="auto-annotation"></p>
    <textarea id="manual-annotation"></textarea>
    <button id="save-annotation"></button>
    <button id="open-file"></button>
    <div id="save-status"></div>
    <p id="agent-empty"></p>
    <ul id="agent-tree"></ul>
    <p id="agent-conflicts"></p>
  `;
}
