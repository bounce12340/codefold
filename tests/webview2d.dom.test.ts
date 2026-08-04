// @vitest-environment happy-dom

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRegistry } from '../src/agents/agentRegistry';
import type {
  AgentReportDetail,
  AgentSnapshot,
  GraphNode,
  NodeDiagnostic,
  NodeDiagnostics,
  NodeState,
  NodeStateUpdate,
  StatusSummary,
  TestFailureDetail,
  TestRunSnapshot,
  WebviewSettings,
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

  it('renders diagnostic source and message and opens the exact location', () => {
    const detail = diagnostic('src/alpha.ts', 'error', 7, 4);
    sendState(
      [nodeState('src/alpha.ts', 'error', [], ['diagnostic'])],
      [],
      { 'src/alpha.ts': [detail] }
    );

    requiredFileCard('src/alpha.ts').click();
    const field = requiredElement<HTMLElement>('diagnostic-field');
    const entries = requiredElement<HTMLUListElement>('node-diagnostics');
    expect(field.hidden).toBe(false);
    expect(entries.textContent).toContain('tsc · error');
    expect(entries.textContent).toContain("Type 'string' is not assignable to type 'number'.");
    expect(entries.textContent).toContain('line 8, column 5');

    requiredElement<HTMLButtonElement>('node-diagnostics')
      .querySelector<HTMLButtonElement>('.diagnostic-entry')
      ?.click();
    expect(postedMessages).toContainEqual({
      type: 'openDiagnostic',
      fileId: 'src/alpha.ts',
      line: 7,
      character: 4
    });
  });

  it('shows a warning diagnostic without applying the error state class', () => {
    group('src').querySelector<HTMLButtonElement>('.folder-header')?.click();
    sendState(
      [nodeState('src/alpha.ts', 'idle')],
      [],
      { 'src/alpha.ts': [diagnostic('src/alpha.ts', 'warning', 10, 1)] }
    );

    const card = requiredFileCard('src/alpha.ts');
    card.click();
    expect(card.classList.contains('node-state-idle')).toBe(true);
    expect(card.classList.contains('node-state-error')).toBe(false);
    expect(requiredElement('node-diagnostics').textContent).toContain('tsc · warning');
  });

  it('runs tests only from the explicit button gesture', () => {
    requiredElement<HTMLButtonElement>('run-tests').click();

    expect(postedMessages).toContainEqual({ type: 'runTests' });
    expect(requiredElement<HTMLButtonElement>('run-tests').disabled).toBe(true);
  });

  it('animates verifying nodes then collapses passing groups without moving them', () => {
    const positionsBefore = groupPositions();
    const forceCallsBefore = d3Spies.forceSimulation.mock.calls.length;
    sendState(
      [nodeState('src/alpha.ts', 'verifying')],
      [],
      {},
      testRun('flow', null, ['src/alpha.ts'])
    );

    expect(group('src').classList.contains('expanded')).toBe(true);
    expect(requiredFileCard('src/alpha.ts').classList.contains('test-flow-active'))
      .toBe(true);
    expect(groupPositions()).toEqual(positionsBefore);

    sendState(
      [nodeState('src/alpha.ts', 'passing')],
      [],
      {},
      testRun('complete', 'passed', ['src/alpha.ts'])
    );

    expect(group('src').classList.contains('expanded')).toBe(false);
    expect(group('src').classList.contains('test-run-passing')).toBe(true);
    expect(groupPositions()).toEqual(positionsBefore);
    expect(d3Spies.forceSimulation).toHaveBeenCalledTimes(forceCallsBefore);
  });

  it('marks uncovered nodes as a dark zone without changing their state', () => {
    // Both groups need a state that keeps them expanded; a fully passing run
    // folds them and there would be no cards left to assert on.
    sendState(
      [
        nodeState('src/alpha.ts', 'error', [], ['test']),
        nodeState('lib/beta.ts', 'editing')
      ],
      [],
      {},
      testRun('complete', 'failed', ['src/alpha.ts'], ['lib/beta.ts'])
    );

    const covered = requiredFileCard('src/alpha.ts');
    const gap = requiredFileCard('lib/beta.ts');

    expect(covered.classList.contains('coverage-gap')).toBe(false);
    expect(gap.classList.contains('coverage-gap')).toBe(true);
    // The overlay coexists with the state machine's own class instead of
    // replacing it — a blind spot can be in any state.
    expect(gap.classList.contains('node-state-editing')).toBe(true);
    expect(gap.dataset.state).toBe('editing');
    expect(gap.getAttribute('aria-label')).toContain('not covered by tests');

    sendState(
      [
        nodeState('src/alpha.ts', 'error', [], ['test']),
        nodeState('lib/beta.ts', 'editing')
      ],
      [],
      {},
      testRun('complete', 'failed', ['src/alpha.ts', 'lib/beta.ts'])
    );

    const relit = requiredFileCard('lib/beta.ts');
    expect(relit.classList.contains('coverage-gap')).toBe(false);
    expect(relit.getAttribute('aria-label')).not.toContain('not covered');
  });

  it('marks import cycle members and spells the loop out in the sidebar', () => {
    sendMessage({
      type: 'graph',
      graph: createGraph({
        cycles: [{
          id: 'cycle:lib/beta.ts|src/alpha.ts',
          nodeIds: ['lib/beta.ts', 'src/alpha.ts']
        }],
        cyclicNodeIds: ['lib/beta.ts', 'src/alpha.ts'],
        cyclicEdgeKeys: [
          'src/alpha.ts\u0000lib/beta.ts',
          'lib/beta.ts\u0000src/alpha.ts'
        ],
        coupling: [
          { nodeId: 'src/alpha.ts', fanIn: 1, fanOut: 1 },
          { nodeId: 'lib/beta.ts', fanIn: 1, fanOut: 1 }
        ]
      })
    });
    sendState([nodeState('src/alpha.ts', 'editing')]);

    const card = requiredFileCard('src/alpha.ts');
    expect(card.classList.contains('dependency-cycle')).toBe(true);
    expect(card.getAttribute('aria-label')).toContain('in an import cycle');

    card.click();

    const field = document.getElementById('dependency-field') as HTMLDivElement;
    const cycles = document.getElementById('node-cycles') as HTMLUListElement;
    expect(field.hidden).toBe(false);
    expect(document.getElementById('node-coupling')?.textContent)
      .toBe('Imported by 1, imports 1.');
    // The selected file leads and repeats at the end, so the loop is explicit.
    expect(cycles.textContent)
      .toContain('src/alpha.ts → lib/beta.ts → src/alpha.ts');
  });

  it('hides the dependency field for a file with no import edges', () => {
    sendMessage({ type: 'graph', graph: createGraph() });
    sendState([nodeState('src/alpha.ts', 'editing')]);
    requiredFileCard('src/alpha.ts').click();

    const field = document.getElementById('dependency-field') as HTMLDivElement;
    expect(field.hidden).toBe(true);
    expect(requiredFileCard('src/alpha.ts').classList.contains('dependency-cycle'))
      .toBe(false);
  });

  it('carries node state in the card label rather than colour alone', () => {
    sendState([nodeState('src/alpha.ts', 'error', [], ['test', 'agent'])]);

    const label = requiredFileCard('src/alpha.ts').getAttribute('aria-label') ?? '';

    expect(label).toContain('state error');
    expect(label).toContain('test, agent');
    expect(label).toContain('src/alpha.ts');
  });

  it('renders a failing test and opens its exact stack location', () => {
    const failure = testFailure();
    sendState(
      [nodeState('src/alpha.ts', 'error', [], ['test'])],
      [],
      {},
      {
        ...testRun('complete', 'failed', ['src/alpha.ts']),
        failures: { 'src/alpha.ts': [failure] }
      }
    );
    requiredFileCard('src/alpha.ts').click();

    expect(requiredElement<HTMLElement>('test-failure-field').hidden).toBe(false);
    expect(requiredElement('node-test-failures').textContent)
      .toContain('test: panel renders state');
    expect(requiredElement('node-test-failures').textContent)
      .toContain('AssertionError: expected true to be false');

    requiredElement('node-test-failures')
      .querySelector<HTMLButtonElement>('.test-failure-entry')
      ?.click();
    expect(postedMessages).toContainEqual({
      type: 'openTestFailure',
      fileId: 'src/alpha.ts',
      line: 12,
      character: 3
    });
  });

  it('renders agent report attribution and the four distinct source labels', () => {
    const reports = {
      'src/alpha.ts': [agentReport('src/alpha.ts', 'reviewer', 'Unsafe fallback.')]
    };
    sendState(
      [nodeState(
        'src/alpha.ts',
        'error',
        [],
        ['test', 'diagnostic', 'runtime', 'agent']
      )],
      [agent('reviewer', 'triangle-copper')],
      {},
      undefined,
      { agentReports: reports }
    );
    requiredFileCard('src/alpha.ts').click();

    expect(requiredElement('node-error-source-list').textContent)
      .toContain('test — Test failure');
    expect(requiredElement('node-error-source-list').textContent)
      .toContain('diagnostic — Static diagnostic');
    expect(requiredElement('node-error-source-list').textContent)
      .toContain('runtime — Runtime exception');
    expect(requiredElement('node-error-source-list').textContent)
      .toContain('agent — Agent report');
    expect(requiredElement('node-agent-reports').textContent)
      .toContain('reviewer (reviewer)');
    expect(requiredElement('node-agent-reports').textContent)
      .toContain('Unsafe fallback.');
  });

  it('updates the status summary and disables flashing through settings', () => {
    const summary: StatusSummary = {
      activeAgents: 2,
      editingNodes: 3,
      errorNodes: 1,
      passingNodes: 4
    };
    sendState(
      [nodeState('src/alpha.ts', 'editing')],
      [],
      {},
      undefined,
      {
        summary,
        settings: { flashAnimations: false }
      }
    );

    expect(requiredElement('state-summary').textContent)
      .toBe('2 agents active · 3 editing · 1 errors · 4 passing');
    expect(document.body.classList.contains('flash-disabled')).toBe(true);

    sendState([], [], {}, undefined, {
      settings: { flashAnimations: true }
    });
    expect(document.body.classList.contains('flash-disabled')).toBe(false);
  });

  it('removes the node badge when agent_done state is received', () => {
    sendState(
      [nodeState('src/alpha.ts', 'editing', ['worker'])],
      [agent('worker', 'hexagon-magenta')]
    );
    expect(requiredFileCard('src/alpha.ts').querySelectorAll('.agent-badge'))
      .toHaveLength(1);

    sendState(
      [nodeState('src/alpha.ts', 'dirty')],
      [{ ...agent('worker', 'hexagon-magenta'), status: 'done', workAreas: [] }]
    );

    expect(requiredFileCard('src/alpha.ts').querySelectorAll('.agent-badge'))
      .toHaveLength(0);
    expect(requiredElement('agent-tree').textContent).toContain('done');
  });
});

function createGraph(health?: WebviewGraph['dependencyHealth']): WebviewGraph {
  const nodes = [
    fileNode('src/alpha.ts', 'alpha.ts'),
    fileNode('lib/beta.ts', 'beta.ts')
  ];
  return {
    nodes,
    edges: [],
    dependencyHealth: health ?? {
      cycles: [],
      cyclicNodeIds: [],
      cyclicEdgeKeys: [],
      coupling: []
    },
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

function diagnostic(
  fileId: string,
  severity: NodeDiagnostic['severity'],
  line: number,
  character: number
): NodeDiagnostic {
  return {
    id: `${fileId}:${line}:${character}:${severity}`,
    fileId,
    source: 'tsc',
    message: severity === 'error'
      ? "Type 'string' is not assignable to type 'number'."
      : 'Unused local variable.',
    severity,
    range: {
      startLine: line,
      startCharacter: character,
      endLine: line,
      endCharacter: character + 3
    }
  };
}

function sendState(
  nodes: GraphNode[],
  agents: AgentSnapshot[] = [],
  diagnostics: NodeDiagnostics = {},
  testRunSnapshot?: TestRunSnapshot,
  extras: {
    agentReports?: Record<string, AgentReportDetail[]>;
    summary?: StatusSummary;
    settings?: WebviewSettings;
  } = {}
): void {
  const update: NodeStateUpdate = {
    nodes,
    agents,
    diagnostics,
    ...(testRunSnapshot ? { testRun: testRunSnapshot } : {}),
    ...extras
  };
  sendMessage({ type: 'stateUpdate', update });
}

function testRun(
  phase: TestRunSnapshot['phase'],
  outcome: TestRunSnapshot['outcome'],
  sequence: string[],
  uncovered: string[] = []
): TestRunSnapshot {
  return {
    phase,
    outcome,
    sequence,
    failures: {},
    message: phase === 'flow' ? 'Tests are flowing.' : 'Tests completed.',
    uncovered
  };
}

function testFailure(): TestFailureDetail {
  return {
    id: 'failure-1',
    testName: 'panel renders state',
    message: 'AssertionError: expected true to be false',
    stack: 'at renderPanel (src/alpha.ts:13:4)',
    source: 'test',
    fileId: 'src/alpha.ts',
    line: 12,
    character: 3
  };
}

function agentReport(
  nodeId: string,
  agentId: string,
  message: string
): AgentReportDetail {
  return {
    id: `${nodeId}:${agentId}`,
    agentId,
    agentName: agentId,
    message,
    fileId: nodeId.split('#')[0],
    nodeId,
    createdAt: '2026-07-28T00:00:00.000Z'
  };
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
    <div id="state-summary"></div>
    <div id="warning"></div>
    <div id="layout-warning"></div>
    <div id="tooltip"></div>
    <button id="run-tests"></button>
    <button id="reset-view"></button>
    <p id="sidebar-empty"></p>
    <div id="node-details"></div>
    <p id="node-name"></p>
    <p id="node-path"></p>
    <p id="node-language"></p>
    <p id="node-state"></p>
    <p id="node-agents"></p>
    <p id="node-errors"></p>
    <div id="error-source-field" hidden>
      <ul id="node-error-source-list"></ul>
    </div>
    <div id="diagnostic-field" hidden>
      <ul id="node-diagnostics"></ul>
    </div>
    <div id="test-failure-field" hidden>
      <ul id="node-test-failures"></ul>
    </div>
    <div id="agent-report-field" hidden>
      <ul id="node-agent-reports"></ul>
    </div>
    <div id="dependency-field" hidden>
      <p id="node-coupling"></p>
      <ul id="node-cycles"></ul>
    </div>
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
