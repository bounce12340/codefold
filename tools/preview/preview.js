(() => {
  'use strict';

  const outboundMessages = [];
  const scenarioOrder = [
    'clean',
    'editing',
    'dirty',
    'parallel',
    'conflict',
    'hierarchy',
    'error',
    'passing',
    'status-colors',
    'functions'
  ];
  const scenarios = {
    clean: {
      label: 'Initial folded workspace',
      acceptance: 'Baseline — compact, stable canvas',
      run: () => sendGraph()
    },
    editing: {
      label: 'One file editing',
      acceptance: 'Acceptance 1 — yellow flashing card',
      run: () => {
        sendGraph();
        sendState([fileUpdate('src/ui/panel.ts', 'editing')]);
      }
    },
    dirty: {
      label: 'One file dirty',
      acceptance: 'Acceptance 1 — dark-yellow steady card',
      run: () => {
        sendGraph();
        sendState([fileUpdate('src/ui/panel.ts', 'dirty')]);
      }
    },
    parallel: {
      label: 'Two agents, different modules',
      acceptance: 'Acceptance 2–3 — parallel expansion and distinct badges',
      run: () => {
        const agents = [
          agent('claude-main', 'Claude main', null, 'diamond-violet', ['src/ui/panel.ts']),
          agent('codex-worker', 'Codex worker', null, 'hexagon-magenta', ['python/worker/main.py'])
        ];
        sendGraph();
        sendState([
          fileUpdate('src/ui/panel.ts', 'editing', ['claude-main']),
          fileUpdate('python/worker/main.py', 'editing', ['codex-worker'])
        ], agents);
      }
    },
    conflict: {
      label: 'Two agents, same node',
      acceptance: 'Acceptance 5 — multiple badges and Potential conflict',
      run: () => {
        const agents = [
          agent('claude-main', 'Claude main', null, 'diamond-violet', ['src/services/api.ts']),
          agent('codex-worker', 'Codex worker', null, 'hexagon-magenta', ['src/services/api.ts'])
        ];
        sendGraph();
        sendState([
          fileUpdate(
            'src/services/api.ts',
            'editing',
            ['claude-main', 'codex-worker']
          )
        ], agents);
      }
    },
    hierarchy: {
      label: 'Parent and spawned subagent',
      acceptance: 'Acceptance 4 — nested agent hierarchy',
      run: () => {
        const agents = [
          agent('claude-main', 'Claude main', null, 'diamond-violet', []),
          agent(
            'claude-researcher',
            'Research subagent',
            'claude-main',
            'hexagon-magenta',
            ['lib/graph/layout.ts']
          )
        ];
        sendGraph();
        sendState([
          fileUpdate('lib/graph/layout.ts', 'editing', ['claude-researcher'])
        ], agents);
      }
    },
    error: {
      label: 'Error',
      acceptance: 'State color check — red flashing error',
      run: () => {
        sendGraph();
        sendState([
          fileUpdate('python/worker/parser.py', 'error', [], ['test'])
        ]);
      }
    },
    passing: {
      label: 'Passing',
      acceptance: 'State color check — steady green passing',
      run: () => {
        sendGraph(['python']);
        sendState([fileUpdate('python/worker/parser.py', 'passing')]);
      }
    },
    'status-colors': {
      label: 'Four state colors together',
      acceptance: 'Compare editing, dirty, error, and passing side by side',
      run: () => {
        const agents = [
          agent('claude-main', 'Claude main', null, 'diamond-violet', ['src/ui/panel.ts'])
        ];
        sendGraph(['src', 'lib', 'python', 'tests']);
        sendState([
          fileUpdate('src/ui/panel.ts', 'editing', ['claude-main']),
          fileUpdate('lib/state/store.ts', 'dirty'),
          fileUpdate('python/worker/parser.py', 'error', [], ['test']),
          fileUpdate('tests/integration/harness.test.ts', 'passing')
        ], agents);
      }
    },
    functions: {
      label: 'Function layer and call edges',
      acceptance: 'Phase 1 granularity used by Phase 2',
      run: () => {
        const agents = [
          agent('codex-worker', 'Codex worker', null, 'triangle-copper', [
            'src/ui/panel.ts#renderPanel'
          ])
        ];
        sendGraph();
        sendState([
          functionUpdate(
            'src/ui/panel.ts#renderPanel',
            'editing',
            ['codex-worker']
          )
        ], agents);
      }
    }
  };

  const themes = {
    dark: {
      '--vscode-editor-background': '#1e1e1e',
      '--vscode-foreground': '#cccccc',
      '--vscode-descriptionForeground': '#9d9d9d',
      '--vscode-editorWidget-background': '#252526',
      '--vscode-editorHoverWidget-background': '#252526',
      '--vscode-editorHoverWidget-foreground': '#cccccc',
      '--vscode-sideBar-background': '#181818',
      '--vscode-sideBar-border': '#2b2b2b',
      '--vscode-widget-border': '#454545',
      '--vscode-focusBorder': '#007fd4',
      '--vscode-editorWarning-foreground': '#cca700',
      '--vscode-errorForeground': '#f14c4c',
      '--vscode-testing-iconPassed': '#73c991',
      '--vscode-button-background': '#0e639c',
      '--vscode-button-hoverBackground': '#1177bb',
      '--vscode-button-foreground': '#ffffff',
      '--vscode-input-background': '#313131',
      '--vscode-input-foreground': '#cccccc',
      '--vscode-input-border': '#5a5a5a',
      '--vscode-editor-font-family': 'Consolas, monospace',
      '--vscode-font-family': '-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
      '--vscode-font-size': '13px'
    },
    light: {
      '--vscode-editor-background': '#ffffff',
      '--vscode-foreground': '#3b3b3b',
      '--vscode-descriptionForeground': '#616161',
      '--vscode-editorWidget-background': '#f3f3f3',
      '--vscode-editorHoverWidget-background': '#f3f3f3',
      '--vscode-editorHoverWidget-foreground': '#3b3b3b',
      '--vscode-sideBar-background': '#f8f8f8',
      '--vscode-sideBar-border': '#d4d4d4',
      '--vscode-widget-border': '#c8c8c8',
      '--vscode-focusBorder': '#0090f1',
      '--vscode-editorWarning-foreground': '#bf8803',
      '--vscode-errorForeground': '#a1260d',
      '--vscode-testing-iconPassed': '#388a34',
      '--vscode-button-background': '#007acc',
      '--vscode-button-hoverBackground': '#0062a3',
      '--vscode-button-foreground': '#ffffff',
      '--vscode-input-background': '#ffffff',
      '--vscode-input-foreground': '#3b3b3b',
      '--vscode-input-border': '#cecece',
      '--vscode-editor-font-family': 'Consolas, monospace',
      '--vscode-font-family': '-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
      '--vscode-font-size': '13px'
    }
  };

  window.acquireVsCodeApi = () => ({
    postMessage(message) {
      outboundMessages.push(message);
      if (!message || typeof message !== 'object') {
        return;
      }
      if (message.type === 'ready') {
        startWhenReady();
      } else if (message.type === 'loadFunctions') {
        sendFunctionPayload(message.fileId);
      }
    }
  });

  window.__codefoldPreview = {
    scenarioIds: [...scenarioOrder],
    outboundMessages,
    applyScenario,
    get currentScenario() {
      return document.documentElement.dataset.previewScenario || '';
    }
  };

  function startWhenReady() {
    const start = () => {
      mountControls();
      const parameters = new URLSearchParams(window.location.search);
      applyTheme(themes[parameters.get('theme')] ? parameters.get('theme') : 'dark');
      applyScenario(scenarios[parameters.get('scenario')]
        ? parameters.get('scenario')
        : 'clean');
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      setTimeout(start, 0);
    }
  }

  function mountControls() {
    if (document.getElementById('preview-controls')) {
      return;
    }
    const style = document.createElement('style');
    style.setAttribute('nonce', 'codefold-preview');
    style.textContent = `
      #preview-controls {
        margin: 0 0 16px; padding: 10px; border-radius: 6px;
        border: 1px solid var(--vscode-widget-border);
        background: var(--vscode-editorWidget-background);
      }
      #preview-controls label { display: block; margin: 0 0 8px; }
      #preview-controls span {
        display: block; margin: 0 0 4px; color: var(--vscode-descriptionForeground);
        font-size: 11px; font-weight: 700; text-transform: uppercase;
      }
      #preview-controls select {
        width: 100%; padding: 5px;
        color: var(--vscode-input-foreground); background: var(--vscode-input-background);
        border: 1px solid var(--vscode-input-border);
      }
      #preview-description {
        margin: 8px 0 0; color: var(--vscode-descriptionForeground);
        font-size: 11px; line-height: 1.4;
      }
    `;
    document.head.append(style);

    const controls = document.createElement('section');
    controls.id = 'preview-controls';
    controls.setAttribute('aria-label', 'Preview controls');

    const scenarioLabel = document.createElement('label');
    scenarioLabel.innerHTML = '<span>Preview scenario</span>';
    const scenarioSelect = document.createElement('select');
    scenarioSelect.id = 'preview-scenario';
    for (const id of scenarioOrder) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = scenarios[id].label;
      scenarioSelect.append(option);
    }
    scenarioSelect.addEventListener('change', () => {
      applyScenario(scenarioSelect.value);
      updateUrl();
    });
    scenarioLabel.append(scenarioSelect);
    controls.append(scenarioLabel);

    const themeLabel = document.createElement('label');
    themeLabel.innerHTML = '<span>VS Code theme tokens</span>';
    const themeSelect = document.createElement('select');
    themeSelect.id = 'preview-theme';
    for (const id of Object.keys(themes)) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = id === 'dark' ? 'Dark' : 'Light';
      themeSelect.append(option);
    }
    themeSelect.addEventListener('change', () => {
      applyTheme(themeSelect.value);
      updateUrl();
    });
    themeLabel.append(themeSelect);
    controls.append(themeLabel);

    const description = document.createElement('p');
    description.id = 'preview-description';
    controls.append(description);
    document.getElementById('sidebar')?.prepend(controls);
  }

  function applyScenario(id) {
    const scenario = scenarios[id] || scenarios.clean;
    const resolvedId = scenarios[id] ? id : 'clean';
    document.documentElement.dataset.previewScenario = resolvedId;
    const select = document.getElementById('preview-scenario');
    if (select) {
      select.value = resolvedId;
    }
    const description = document.getElementById('preview-description');
    if (description) {
      description.textContent = scenario.acceptance;
    }
    scenario.run();
  }

  function applyTheme(id) {
    const resolvedId = themes[id] ? id : 'dark';
    for (const [name, value] of Object.entries(themes[resolvedId])) {
      document.documentElement.style.setProperty(name, value);
    }
    document.documentElement.dataset.previewTheme = resolvedId;
    const select = document.getElementById('preview-theme');
    if (select) {
      select.value = resolvedId;
    }
  }

  function updateUrl() {
    const parameters = new URLSearchParams(window.location.search);
    parameters.set('scenario', document.documentElement.dataset.previewScenario || 'clean');
    parameters.set('theme', document.documentElement.dataset.previewTheme || 'dark');
    history.replaceState(null, '', `${window.location.pathname}?${parameters}`);
  }

  function sendGraph(expandedFolders = []) {
    window.postMessage({
      type: 'graph',
      graph: createGraph(expandedFolders)
    }, '*');
  }

  function sendState(nodes, agents = []) {
    window.postMessage({
      type: 'stateUpdate',
      update: { nodes, agents }
    }, '*');
  }

  function sendFunctionPayload(fileId) {
    const nodes = createFunctionNodes();
    const edges = createFunctionEdges(nodes);
    const localNodes = nodes.filter((node) => node.path === fileId);
    const localIds = new Set(localNodes.map((node) => node.id));
    const relevantEdges = edges.filter((edge) =>
      (edge.kind === 'contains' && edge.from === fileId)
      || (
        edge.kind === 'call'
        && (localIds.has(edge.from) || localIds.has(edge.to))
      )
    );
    const relatedIds = new Set(
      relevantEdges.flatMap((edge) => [edge.from, edge.to])
    );
    window.postMessage({
      type: 'functions',
      payload: {
        fileId,
        nodes: nodes.filter((node) =>
          localIds.has(node.id) || relatedIds.has(node.id)
        ),
        edges: relevantEdges
      }
    }, '*');
  }

  function createGraph(expandedFolders) {
    const nodes = createFiles();
    const functionNodes = createFunctionNodes();
    const functionCounts = {};
    for (const node of functionNodes) {
      functionCounts[node.path] = (functionCounts[node.path] || 0) + 1;
    }
    const expanded = new Set(expandedFolders);
    return {
      nodes,
      edges: createImportEdges(),
      seed: 0x5eed1234,
      truncated: false,
      totalFiles: nodes.length,
      totalFunctions: functionNodes.length,
      functionCounts,
      layout: {
        version: 1,
        groups: {
          'folder:src': { x: -470, y: -270, expanded: expanded.has('src') },
          'folder:lib': { x: 350, y: -270, expanded: expanded.has('lib') },
          'folder:python': { x: -470, y: 250, expanded: expanded.has('python') },
          'folder:tests': { x: 350, y: 250, expanded: expanded.has('tests') }
        },
        files: {}
      }
    };
  }

  function createFiles() {
    return [
      file('src/index.ts', 'Bootstraps the extension commands and view lifecycle.'),
      file('src/ui/panel.ts', 'Coordinates the two-dimensional dependency canvas.'),
      file('src/ui/canvas.ts', 'Handles pan, zoom, cards, and SVG dependency edges.'),
      file('src/services/api.ts', 'Maps hook events into workspace state updates.'),
      file('src/services/session.ts', 'Tracks active agents and their current work areas.'),
      file('lib/graph/layout.ts', 'Computes deterministic initial group positions.'),
      file('lib/graph/edges.ts', 'Aggregates import and call edges for display.'),
      file('lib/state/store.ts', 'Resolves node state priority and edit ownership.'),
      file('python/worker/main.py', 'Runs background parsing jobs for Python files.', 'py'),
      file('python/worker/parser.py', 'Extracts Python classes, functions, and calls.', 'py'),
      file('python/tests/test_parser.py', 'Checks Python symbol and range extraction.', 'py'),
      file('tests/integration/harness.test.ts', 'Exercises the browser preview scenarios.'),
      file('tests/unit/state.test.ts', 'Verifies editing, dirty, passing, and error states.')
    ];
  }

  function createImportEdges() {
    return [
      edge('src/index.ts', 'src/ui/panel.ts', 'import'),
      edge('src/index.ts', 'src/services/api.ts', 'import'),
      edge('src/ui/panel.ts', 'src/ui/canvas.ts', 'import'),
      edge('src/ui/panel.ts', 'lib/graph/layout.ts', 'import'),
      edge('src/ui/canvas.ts', 'lib/graph/edges.ts', 'import'),
      edge('src/services/api.ts', 'src/services/session.ts', 'import'),
      edge('src/services/api.ts', 'lib/state/store.ts', 'import'),
      edge('lib/graph/layout.ts', 'lib/graph/edges.ts', 'import'),
      edge('python/worker/main.py', 'python/worker/parser.py', 'import'),
      edge('python/tests/test_parser.py', 'python/worker/parser.py', 'import'),
      edge('tests/integration/harness.test.ts', 'src/ui/panel.ts', 'import'),
      edge('tests/integration/harness.test.ts', 'src/services/api.ts', 'import'),
      edge('tests/unit/state.test.ts', 'lib/state/store.ts', 'import')
    ];
  }

  function createFunctionNodes() {
    return [
      func('src/index.ts', 'activate', 4, 18),
      func('src/ui/panel.ts', 'renderPanel', 8, 31),
      func('src/ui/panel.ts', 'applyGraph', 33, 55),
      func('src/ui/panel.ts', 'applyStateUpdate', 57, 82),
      func('src/ui/canvas.ts', 'drawEdges', 12, 40),
      func('src/ui/canvas.ts', 'fitToContent', 42, 68),
      func('src/services/api.ts', 'acceptHookEvent', 9, 34),
      func('src/services/api.ts', 'resolveTarget', 36, 60),
      func('src/services/session.ts', 'AgentRegistry', 3, 48),
      func('lib/graph/layout.ts', 'layoutGroups', 7, 39),
      func('lib/graph/edges.ts', 'visibleEdges', 5, 42),
      func('lib/state/store.ts', 'resolveNodeState', 3, 22),
      func('python/worker/main.py', 'run_worker', 5, 22, 'py'),
      func('python/worker/parser.py', 'Parser', 4, 38, 'py'),
      func('python/worker/parser.py', 'Parser.parse_file', 9, 25, 'py'),
      func('python/tests/test_parser.py', 'test_extracts_functions', 5, 16, 'py'),
      func('tests/integration/harness.test.ts', 'loadsPreview', 8, 24),
      func('tests/unit/state.test.ts', 'resolvesPriority', 6, 20)
    ];
  }

  function createFunctionEdges(nodes) {
    const contains = nodes.map((node) => edge(node.path, node.id, 'contains'));
    return [
      ...contains,
      edge('src/index.ts#activate', 'src/ui/panel.ts#renderPanel', 'call'),
      edge('src/ui/panel.ts#renderPanel', 'src/ui/panel.ts#applyGraph', 'call'),
      edge('src/ui/panel.ts#applyGraph', 'lib/graph/layout.ts#layoutGroups', 'call'),
      edge('src/ui/panel.ts#applyStateUpdate', 'lib/state/store.ts#resolveNodeState', 'call'),
      edge('src/ui/canvas.ts#drawEdges', 'lib/graph/edges.ts#visibleEdges', 'call'),
      edge('src/services/api.ts#acceptHookEvent', 'src/services/api.ts#resolveTarget', 'call'),
      edge('python/worker/main.py#run_worker', 'python/worker/parser.py#Parser.parse_file', 'call')
    ];
  }

  function file(path, annotation, lang = 'ts') {
    return {
      id: path,
      kind: 'file',
      path,
      name: path.split('/').pop(),
      range: { startLine: 0, endLine: 100 },
      lang,
      state: 'idle',
      errorSources: [],
      editingAgents: [],
      annotation: { auto: annotation, manual: null },
      lastVerifiedAt: null
    };
  }

  function func(path, name, startLine, endLine, lang = 'ts') {
    return {
      id: `${path}#${name}`,
      kind: 'function',
      path,
      name,
      range: { startLine, endLine },
      lang,
      state: 'idle',
      errorSources: [],
      editingAgents: [],
      annotation: { auto: null, manual: null },
      lastVerifiedAt: null
    };
  }

  function fileUpdate(path, state, editingAgents = [], errorSources = []) {
    const source = createFiles().find((node) => node.id === path);
    return {
      ...source,
      state,
      editingAgents,
      errorSources
    };
  }

  function functionUpdate(id, state, editingAgents = [], errorSources = []) {
    const source = createFunctionNodes().find((node) => node.id === id);
    return {
      ...source,
      state,
      editingAgents,
      errorSources
    };
  }

  function agent(id, name, parentId, badge, workAreas) {
    return {
      id,
      name,
      parentId,
      badge,
      status: 'active',
      workAreas
    };
  }

  function edge(from, to, kind) {
    return { from, to, kind };
  }
})();
