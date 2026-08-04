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
    'state-passing',
    'verifying',
    'passing',
    'test-failure',
    'test-mixed',
    'status-colors',
    'functions',
    'diagnostics',
    'diagnostics-warning',
    'diagnostics-multi-source',
    'agent-report',
    'all-error-sources',
    'status-bar-summary',
    'multi-agent-lifecycle',
    'coverage-gap',
    'dependency-health'
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
    'state-passing': {
      label: 'Passing state card',
      acceptance: 'State color check — steady green passing',
      run: () => {
        sendGraph(['python']);
        sendState([fileUpdate('python/worker/parser.py', 'passing')]);
      }
    },
    verifying: {
      label: 'Coverage light flow in progress',
      acceptance: 'Phase 4 acceptance 1 — ordered neutral glow along call edges',
      run: () => {
        const sequence = [
          'src/ui/panel.ts',
          'src/ui/panel.ts#renderPanel',
          'src/ui/panel.ts#applyGraph',
          'lib/graph/layout.ts#layoutGroups'
        ];
        sendGraph();
        sendState(
          [
            fileUpdate('src/ui/panel.ts', 'verifying'),
            functionUpdate('src/ui/panel.ts#renderPanel', 'verifying'),
            functionUpdate('src/ui/panel.ts#applyGraph', 'verifying'),
            functionUpdate('lib/graph/layout.ts#layoutGroups', 'verifying')
          ],
          [],
          {},
          testRun('flow', null, sequence, {}, 'Coverage path is flowing.')
        );
      }
    },
    passing: {
      label: 'All tests passing and folded',
      acceptance: 'Phase 4 acceptance 1 — green result returns to compact groups',
      run: () => {
        const sequence = [
          'src/ui/panel.ts',
          'src/ui/panel.ts#renderPanel',
          'lib/graph/layout.ts',
          'lib/graph/layout.ts#layoutGroups'
        ];
        sendGraph(['src', 'lib']);
        sendState(
          [
            fileUpdate('src/ui/panel.ts', 'passing'),
            functionUpdate('src/ui/panel.ts#renderPanel', 'passing'),
            fileUpdate('lib/graph/layout.ts', 'passing'),
            functionUpdate('lib/graph/layout.ts#layoutGroups', 'passing')
          ],
          [],
          {},
          testRun(
            'complete',
            'passed',
            sequence,
            {},
            'Tests passed; covered groups are folded.'
          )
        );
      }
    },
    'coverage-gap': {
      label: 'Coverage dark zones',
      acceptance: 'ROADMAP 6 — instrumented but never executed nodes read as unlit',
      run: () => {
        const sequence = [
          'src/ui/panel.ts',
          'src/ui/panel.ts#renderPanel'
        ];
        // Every card here is in the same error state, so the only thing that
        // can differ visually is the coverage overlay itself.
        sendGraph(['src', 'lib']);
        sendState(
          [
            fileUpdate('src/ui/panel.ts', 'error', [], ['test']),
            fileUpdate('lib/graph/layout.ts', 'error', [], ['test']),
            functionUpdate('lib/graph/layout.ts#layoutGroups', 'error')
          ],
          [],
          {},
          testRun(
            'complete',
            'failed',
            sequence,
            {},
            'Tests failed; two nodes were never executed.',
            [
              'lib/graph/layout.ts',
              'lib/graph/layout.ts#layoutGroups'
            ]
          )
        );
      }
    },
    'dependency-health': {
      label: 'Import cycle',
      acceptance: 'ROADMAP 7 — cycle members and the edges that close the loop',
      run: () => {
        // canvas.ts -> edges.ts already exists in the fixture; adding the
        // reverse edge closes a real two-file cycle across two folders.
        const cycleMembers = ['lib/graph/edges.ts', 'src/ui/canvas.ts'];
        sendGraph(['src', 'lib'], {
          extraEdges: [edge('lib/graph/edges.ts', 'src/ui/canvas.ts', 'import')],
          dependencyHealth: {
            cycles: [{ id: `cycle:${cycleMembers.join('|')}`, nodeIds: cycleMembers }],
            cyclicNodeIds: cycleMembers,
            cyclicEdgeKeys: [
              cycleEdgeKey('lib/graph/edges.ts', 'src/ui/canvas.ts'),
              cycleEdgeKey('src/ui/canvas.ts', 'lib/graph/edges.ts')
            ],
            // The same two files live in different folders, so the boundary
            // violation shows up at the folder layer as well.
            folderCycles: [{
              id: 'cycle:folder:lib|folder:src',
              nodeIds: ['folder:lib', 'folder:src']
            }],
            cyclicFolderIds: ['folder:lib', 'folder:src'],
            cyclicFolderEdgeKeys: [
              cycleEdgeKey('folder:lib', 'folder:src'),
              cycleEdgeKey('folder:src', 'folder:lib')
            ],
            coupling: [
              { nodeId: 'src/ui/canvas.ts', fanIn: 2, fanOut: 1 },
              { nodeId: 'lib/graph/edges.ts', fanIn: 2, fanOut: 1 },
              { nodeId: 'src/ui/panel.ts', fanIn: 2, fanOut: 2 }
            ]
          }
        });
        sendState([fileUpdate('src/ui/canvas.ts', 'idle')]);
        selectNodeLater('src/ui/canvas.ts');
      }
    },
    'test-failure': {
      label: 'Failing test path',
      acceptance: 'Phase 4 acceptance 2 — red node, failure name, stack trace',
      run: () => {
        const detail = testFailure(
          'src/ui/panel.ts',
          'panel renders state',
          'AssertionError: expected true to be false',
          'test'
        );
        sendGraph();
        sendState(
          [
            fileUpdate('src/ui/panel.ts', 'error', [], ['test']),
            functionUpdate(
              'src/ui/panel.ts#renderPanel',
              'error',
              [],
              ['test']
            )
          ],
          [],
          {},
          testRun(
            'complete',
            'failed',
            ['src/ui/panel.ts', 'src/ui/panel.ts#renderPanel'],
            {
              'src/ui/panel.ts': [detail],
              'src/ui/panel.ts#renderPanel': [detail]
            },
            'Tests failed with exit code 1.'
          )
        );
        selectNodeLater('src/ui/panel.ts#renderPanel');
      }
    },
    'test-mixed': {
      label: 'Passing and failing paths together',
      acceptance: 'Phase 4 color check — steady green and flashing red coexist',
      run: () => {
        const detail = testFailure(
          'python/worker/parser.py',
          'test_extracts_functions',
          'RuntimeError: parser crashed',
          'runtime'
        );
        sendGraph(['lib']);
        sendState(
          [
            fileUpdate('lib/state/store.ts', 'passing'),
            fileUpdate('python/worker/parser.py', 'error', [], ['runtime'])
          ],
          [],
          {},
          testRun(
            'complete',
            'failed',
            ['lib/state/store.ts', 'python/worker/parser.py'],
            { 'python/worker/parser.py': [detail] },
            'Python tests failed with a runtime exception.'
          )
        );
        selectNodeLater('python/worker/parser.py');
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
    },
    diagnostics: {
      label: 'Error diagnostics on file and function',
      acceptance: 'Phase 3 acceptance 1 — red flash and diagnostic details',
      run: () => {
        const detail = diagnostic(
          'src/ui/panel.ts',
          'error',
          14,
          8,
          "Type 'string' is not assignable to type 'number'.",
          'tsc'
        );
        sendGraph();
        sendState(
          [
            fileUpdate('src/ui/panel.ts', 'error', [], ['diagnostic']),
            functionUpdate(
              'src/ui/panel.ts#renderPanel',
              'error',
              [],
              ['diagnostic']
            )
          ],
          [],
          {
            'src/ui/panel.ts': [detail],
            'src/ui/panel.ts#renderPanel': [detail]
          }
        );
        selectNodeLater('src/ui/panel.ts#renderPanel');
      }
    },
    'diagnostics-warning': {
      label: 'Warning diagnostic without error state',
      acceptance: 'Phase 3 acceptance 3 — warning details, no red card',
      run: () => {
        const detail = diagnostic(
          'src/ui/canvas.ts',
          'warning',
          25,
          4,
          'Variable is declared but its value is never read.',
          'eslint'
        );
        sendGraph(['src']);
        sendState(
          [fileUpdate('src/ui/canvas.ts', 'idle')],
          [],
          { 'src/ui/canvas.ts': [detail] }
        );
        selectNodeLater('src/ui/canvas.ts');
      }
    },
    'diagnostics-multi-source': {
      label: 'Diagnostic error while an agent is editing',
      acceptance: 'Phase 3 priority — error beats editing and sources coexist',
      run: () => {
        const agents = [
          agent(
            'claude-main',
            'Claude main',
            null,
            'diamond-violet',
            ['src/services/api.ts']
          )
        ];
        const detail = diagnostic(
          'src/services/api.ts',
          'error',
          18,
          2,
          "Property 'payload' does not exist on type 'HookEvent'.",
          'tsc'
        );
        sendGraph();
        sendState(
          [
            fileUpdate(
              'src/services/api.ts',
              'error',
              ['claude-main'],
              ['diagnostic', 'agent']
            )
          ],
          agents,
          { 'src/services/api.ts': [detail] }
        );
        selectNodeLater('src/services/api.ts');
      }
    },
    'agent-report': {
      label: 'Agent-reported problem',
      acceptance: 'Phase 5 acceptance 1 — red node with reporter attribution',
      run: () => {
        const agents = [
          agent('codex-reviewer', 'Codex reviewer', null, 'triangle-copper', [])
        ];
        const report = agentReport(
          'src/services/api.ts#acceptHookEvent',
          'codex-reviewer',
          'Token rejection path can leak the request body length.'
        );
        sendGraph();
        sendState(
          [
            fileUpdate('src/services/api.ts', 'error', [], ['agent']),
            functionUpdate(
              'src/services/api.ts#acceptHookEvent',
              'error',
              [],
              ['agent']
            )
          ],
          agents,
          {},
          undefined,
          {
            agentReports: {
              'src/services/api.ts': [report],
              'src/services/api.ts#acceptHookEvent': [report]
            },
            summary: statusSummary(1, 0, 2, 0)
          }
        );
        selectNodeLater('src/services/api.ts#acceptHookEvent');
      }
    },
    'all-error-sources': {
      label: 'All four error sources',
      acceptance: 'Phase 5 acceptance 2 — test/diagnostic/runtime/agent are distinct',
      run: () => {
        const nodeId = 'src/services/api.ts';
        const diagnosticDetail = diagnostic(
          nodeId,
          'error',
          18,
          2,
          "Property 'payload' does not exist on type 'HookEvent'.",
          'tsc'
        );
        const testDetail = testFailure(
          nodeId,
          'hook rejects malformed events',
          'AssertionError: expected 400 to equal 202',
          'test'
        );
        const runtimeDetail = testFailure(
          nodeId,
          'hook handles closed sockets',
          'Error: write after end',
          'runtime'
        );
        const report = agentReport(
          nodeId,
          'claude-main',
          'Malformed event branch can double-send the HTTP response.'
        );
        sendGraph();
        sendState(
          [
            fileUpdate(
              nodeId,
              'error',
              [],
              ['test', 'diagnostic', 'runtime', 'agent']
            )
          ],
          [agent('claude-main', 'Claude main', null, 'diamond-violet', [])],
          { [nodeId]: [diagnosticDetail] },
          testRun(
            'complete',
            'failed',
            [nodeId],
            { [nodeId]: [testDetail, runtimeDetail] },
            'Multiple error sources remain active.'
          ),
          {
            agentReports: { [nodeId]: [report] },
            summary: statusSummary(1, 0, 1, 0)
          }
        );
        selectNodeLater(nodeId);
      }
    },
    'status-bar-summary': {
      label: 'Status bar summary and static flashes',
      acceptance: 'Phase 5 summary counts and disabled flashing setting',
      run: () => {
        const agents = [
          agent('claude-main', 'Claude main', null, 'diamond-violet', [
            'src/ui/panel.ts'
          ]),
          agent('codex-worker', 'Codex worker', null, 'hexagon-magenta', [
            'python/worker/main.py'
          ])
        ];
        sendGraph(['tests']);
        sendState(
          [
            fileUpdate('src/ui/panel.ts', 'editing', ['claude-main']),
            fileUpdate('python/worker/main.py', 'editing', ['codex-worker']),
            fileUpdate('src/services/api.ts', 'error', [], ['agent']),
            fileUpdate('tests/integration/harness.test.ts', 'passing'),
            fileUpdate('tests/unit/state.test.ts', 'passing')
          ],
          agents,
          {},
          undefined,
          {
            summary: statusSummary(2, 2, 1, 2),
            settings: { flashAnimations: false }
          }
        );
      }
    },
    'multi-agent-lifecycle': {
      label: 'Main agent and two subagents',
      acceptance: 'Phase 5 acceptance 3 — active hierarchy and completed badge cleanup',
      run: () => {
        const step = new URLSearchParams(window.location.search).get('step') === 'done'
          ? 'done'
          : 'active';
        document.documentElement.dataset.previewStep = step;
        const done = step === 'done';
        const agents = [
          {
            ...agent('claude-main', 'Claude main', null, 'diamond-violet', []),
            status: done ? 'done' : 'active'
          },
          {
            ...agent(
              'ui-worker',
              'UI subagent',
              'claude-main',
              'hexagon-magenta',
              done ? [] : ['src/ui/panel.ts']
            ),
            status: done ? 'done' : 'active'
          },
          {
            ...agent(
              'python-worker',
              'Python subagent',
              'claude-main',
              'triangle-copper',
              done ? [] : ['python/worker/parser.py']
            ),
            status: done ? 'done' : 'active'
          }
        ];
        sendGraph();
        sendState(
          [
            fileUpdate(
              'src/ui/panel.ts',
              done ? 'dirty' : 'editing',
              done ? [] : ['ui-worker']
            ),
            fileUpdate(
              'python/worker/parser.py',
              done ? 'dirty' : 'editing',
              done ? [] : ['python-worker']
            )
          ],
          agents,
          {},
          undefined,
          {
            summary: done
              ? statusSummary(0, 0, 0, 0)
              : statusSummary(3, 2, 0, 0)
          }
        );
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
    measureVisuals,
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
    document.documentElement.dataset.previewStep = '';
    const select = document.getElementById('preview-scenario');
    if (select) {
      select.value = resolvedId;
    }
    const description = document.getElementById('preview-description');
    if (description) {
      description.textContent = scenario.acceptance;
    }
    scenario.run();
    scheduleVisualMeasurement();
  }

  function applyTheme(id) {
    const resolvedId = themes[id] ? id : 'dark';
    for (const [name, value] of Object.entries(themes[resolvedId])) {
      document.documentElement.style.setProperty(name, value);
    }
    document.documentElement.dataset.previewTheme = resolvedId;
    document.body.classList.toggle('vscode-dark', resolvedId === 'dark');
    document.body.classList.toggle('vscode-light', resolvedId === 'light');
    const select = document.getElementById('preview-theme');
    if (select) {
      select.value = resolvedId;
    }
    scheduleVisualMeasurement();
  }

  let visualMeasurementTimer;

  function scheduleVisualMeasurement() {
    clearTimeout(visualMeasurementTimer);
    visualMeasurementTimer = setTimeout(() => {
      const metrics = measureVisuals();
      document.documentElement.dataset.previewMetrics =
        btoa(unescape(encodeURIComponent(JSON.stringify(metrics))));
    }, 320);
  }

  function measureVisuals() {
    const stateCards = {};
    for (const state of ['editing', 'dirty', 'error', 'passing', 'verifying', 'idle']) {
      const card = document.querySelector(`.node-state-${state}`);
      if (!card) {
        continue;
      }
      const style = getComputedStyle(card);
      const lamp = card.querySelector('.node-state-lamp');
      const lampStyle = lamp ? getComputedStyle(lamp) : null;
      stateCards[state] = {
        borderColor: style.borderColor,
        borderWidth: style.borderWidth,
        boxShadow: style.boxShadow,
        backgroundColor: style.backgroundColor,
        animationName: style.animationName,
        animationDuration: style.animationDuration,
        lampColor: lampStyle?.backgroundColor || '',
        lampWidth: lampStyle?.width || '',
        lampHeight: lampStyle?.height || '',
        lampRadius: lampStyle?.borderRadius || '',
        // Colour-independent signature: two states sharing this string are
        // indistinguishable to a viewer who cannot tell their hues apart.
        lampShape: [
          lampStyle?.width || '',
          lampStyle?.height || '',
          lampStyle?.borderRadius || '',
          lampStyle?.clipPath || 'none',
          lampStyle?.backgroundColor === 'rgba(0, 0, 0, 0)' ? 'hollow' : 'solid'
        ].join('/'),
        cardLabel: card.getAttribute('aria-label') || ''
      };
    }

    const gapCards = Array.from(document.querySelectorAll('.coverage-gap'));
    const litCard = document.querySelector(
      '.file-card:not(.coverage-gap), .function-card:not(.coverage-gap)'
    );
    const gapStyle = gapCards[0] ? getComputedStyle(gapCards[0]) : null;
    const litStyle = litCard ? getComputedStyle(litCard) : null;
    const coverage = {
      gapCards: gapCards.length,
      gapOpacity: gapStyle?.opacity || '',
      gapBorderStyle: gapStyle?.borderStyle || '',
      litOpacity: litStyle?.opacity || '',
      litBorderStyle: litStyle?.borderStyle || '',
      gapLabels: gapCards.map((card) => card.getAttribute('aria-label') || '')
    };

    const cycleEdges = Array.from(document.querySelectorAll('.dependency.cycle'));
    const plainImportEdges = Array.from(
      document.querySelectorAll('.dependency.import:not(.cycle)')
    );
    const cycleCards = Array.from(document.querySelectorAll(
      '.file-card.dependency-cycle, .function-card.dependency-cycle'
    ));
    const dependency = {
      cycleEdges: cycleEdges.length,
      plainImportEdges: plainImportEdges.length,
      cycleCards: cycleCards.length,
      cycleDash: cycleEdges[0] ? getComputedStyle(cycleEdges[0]).strokeDasharray : '',
      plainDash: plainImportEdges[0]
        ? getComputedStyle(plainImportEdges[0]).strokeDasharray
        : '',
      cycleGroups: document.querySelectorAll('.folder-group.dependency-cycle').length,
      plainGroups: document.querySelectorAll(
        '.folder-group:not(.dependency-cycle)'
      ).length,
      couplingText: document.getElementById('node-coupling')?.textContent || '',
      cycleText: document.getElementById('node-cycles')?.textContent || '',
      cycleLabels: cycleCards.map((card) => card.getAttribute('aria-label') || '')
    };

    const parent = document.querySelector(
      '.file-card[data-node-id="src/ui/panel.ts"]'
    );
    const functions = Array.from(document.querySelectorAll(
      '.function-card[data-node-id^="src/ui/panel.ts#"]'
    ));
    const contains = Array.from(document.querySelectorAll('.dependency.contains'));
    const expandedGroup = document.querySelector('.folder-group.expanded');
    const parentRect = parent?.getBoundingClientRect();
    return {
      scenario: document.documentElement.dataset.previewScenario || '',
      theme: document.documentElement.dataset.previewTheme || '',
      stateCards,
      coverage,
      dependency,
      functions: {
        ownerLabels: functions.map((card) =>
          card.querySelector('.function-owner')?.textContent || ''
        ),
        containsEdges: contains.length,
        containsStroke: contains[0] ? getComputedStyle(contains[0]).stroke : '',
        containsStrokeWidth: contains[0]
          ? getComputedStyle(contains[0]).strokeWidth
          : '',
        functionTransitionDuration: functions[0]
          ? getComputedStyle(functions[0]).transitionDuration
          : '',
        groupTransitionDuration: expandedGroup
          ? getComputedStyle(expandedGroup).transitionDuration
          : '',
        parentToFirstGap: parentRect && functions[0]
          ? Math.round(functions[0].getBoundingClientRect().left - parentRect.right)
          : null
      },
      testRun: {
        flowNodes: document.querySelectorAll('.test-flow-active').length,
        flowEdges: document.querySelectorAll('.test-flow-edge').length,
        passingGroups: document.querySelectorAll('.folder-group.test-run-passing').length,
        failureEntries: document.querySelectorAll('.test-failure-entry').length
      },
      phase5: {
        step: document.documentElement.dataset.previewStep || '',
        summary: document.getElementById('state-summary')?.textContent || '',
        errorSourceLabels: Array.from(document.querySelectorAll(
          '.error-source-chip'
        )).map((entry) => entry.textContent || ''),
        agentReports: Array.from(document.querySelectorAll(
          '.agent-report-entry'
        )).map((entry) => entry.textContent || ''),
        flashDisabled: document.body.classList.contains('flash-disabled'),
        editingAnimation: document.querySelector('.node-state-editing')
          ? getComputedStyle(document.querySelector('.node-state-editing')).animationName
          : '',
        errorAnimation: document.querySelector('.node-state-error')
          ? getComputedStyle(document.querySelector('.node-state-error')).animationName
          : '',
        doneAgents: Array.from(document.querySelectorAll('.agent-status'))
          .filter((entry) => entry.textContent === 'done').length
      }
    };
  }

  function updateUrl() {
    const parameters = new URLSearchParams(window.location.search);
    parameters.set('scenario', document.documentElement.dataset.previewScenario || 'clean');
    parameters.set('theme', document.documentElement.dataset.previewTheme || 'dark');
    history.replaceState(null, '', `${window.location.pathname}?${parameters}`);
  }

  function sendGraph(expandedFolders = [], options = {}) {
    window.postMessage({
      type: 'graph',
      graph: createGraph(expandedFolders, options)
    }, '*');
  }

  function sendState(
    nodes,
    agents = [],
    diagnostics = {},
    testRunSnapshot,
    extras = {}
  ) {
    window.postMessage({
      type: 'stateUpdate',
      update: {
        nodes,
        agents,
        diagnostics,
        ...(testRunSnapshot ? { testRun: testRunSnapshot } : {}),
        ...extras
      }
    }, '*');
  }

  function selectNodeLater(nodeId) {
    setTimeout(() => {
      const card = Array.from(document.querySelectorAll('[data-node-id]'))
        .find((candidate) => candidate.dataset.nodeId === nodeId);
      card?.click();
      scheduleVisualMeasurement();
    }, 180);
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

  function createGraph(expandedFolders, options = {}) {
    const nodes = createFiles();
    const functionNodes = createFunctionNodes();
    const functionCounts = {};
    for (const node of functionNodes) {
      functionCounts[node.path] = (functionCounts[node.path] || 0) + 1;
    }
    const expanded = new Set(expandedFolders);
    return {
      nodes,
      edges: [...createImportEdges(), ...(options.extraEdges || [])],
      dependencyHealth: options.dependencyHealth || {
        cycles: [],
        cyclicNodeIds: [],
        cyclicEdgeKeys: [],
        coupling: [],
        folderCycles: [],
        cyclicFolderIds: [],
        cyclicFolderEdgeKeys: []
      },
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

  // Must match edgeKey() in the product webview, which joins with NUL.
  function cycleEdgeKey(from, to) {
    return `${from}\u0000${to}`;
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

  function diagnostic(fileId, severity, line, character, message, source) {
    return {
      id: `${fileId}:${line}:${character}:${severity}:${source}`,
      fileId,
      source,
      message,
      severity,
      range: {
        startLine: line,
        startCharacter: character,
        endLine: line,
        endCharacter: character + 4
      }
    };
  }

  function testRun(phase, outcome, sequence, failures, message, uncovered) {
    return { phase, outcome, sequence, failures, message, uncovered: uncovered || [] };
  }

  function testFailure(fileId, testName, message, source) {
    const line = fileId.endsWith('.py') ? 11 : 14;
    const character = fileId.endsWith('.py') ? 0 : 2;
    return {
      id: `${source}:${fileId}:${testName}`,
      testName,
      message,
      stack: fileId.endsWith('.py')
        ? `File "${fileId}", line ${line + 1}, in parse_file\n${message}`
        : `at renderPanel (${fileId}:${line + 1}:${character + 1})\n${message}`,
      source,
      fileId,
      line,
      character
    };
  }

  function agentReport(nodeId, agentId, message) {
    return {
      id: `${nodeId}:${agentId}`,
      agentId,
      agentName: agentId === 'claude-main' ? 'Claude main' : 'Codex reviewer',
      message,
      fileId: nodeId.split('#')[0],
      nodeId,
      createdAt: '2026-07-28T00:00:00.000Z'
    };
  }

  function statusSummary(activeAgents, editingNodes, errorNodes, passingNodes) {
    return { activeAgents, editingNodes, errorNodes, passingNodes };
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
