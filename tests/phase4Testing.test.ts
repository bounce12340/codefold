import { describe, expect, it } from 'vitest';
import type { GraphNode } from '../src/scanner/model';
import { NodeStateStore } from '../src/state/nodeStateMachine';
import {
  mapCoverageToNodes,
  parseCoverageJson
} from '../src/testing/coverage';
import {
  mapFailuresToNodes,
  parseTestFailures
} from '../src/testing/failures';
import {
  DEFAULT_RUN_TESTS_ON_SAVE,
  createTestCommandPlans,
  resolveTestSettings
} from '../src/testing/testConfig';
import { TestRunTracker } from '../src/testing/testRunTracker';

const workspaceRoot = 'C:\\repo';

describe('Phase 4 test tracking', () => {
  it('parses Istanbul coverage and maps covered lines to file and function nodes', () => {
    const records = parseCoverageJson(JSON.stringify({
      'C:\\repo\\src\\panel.ts': {
        path: 'C:\\repo\\src\\panel.ts',
        statementMap: {
          0: { start: { line: 4, column: 0 }, end: { line: 4, column: 8 } },
          1: { start: { line: 14, column: 2 }, end: { line: 14, column: 12 } },
          2: { start: { line: 40, column: 0 }, end: { line: 40, column: 4 } }
        },
        s: { 0: 1, 1: 3, 2: 0 }
      }
    }));

    const mapping = mapCoverageToNodes(graphNodes(), records, workspaceRoot);

    expect(records).toEqual([{
      path: 'C:\\repo\\src\\panel.ts',
      executedLines: [3, 13]
    }]);
    expect(mapping.sequence).toEqual([
      'src/panel.ts',
      'src/panel.ts#renderPanel'
    ]);
    expect(mapping.nodeIds).toEqual([
      'src/panel.ts',
      'src/panel.ts#renderPanel'
    ]);
    // savePanel is instrumented but no statement inside it ran.
    expect(mapping.uncoveredNodeIds).toEqual(['src/panel.ts#savePanel']);
  });

  it('darkens every function of a file the report shows as fully unexecuted', () => {
    const records = parseCoverageJson(JSON.stringify({
      'C:\\repo\\src\\panel.ts': {
        path: 'C:\\repo\\src\\panel.ts',
        statementMap: {
          0: { start: { line: 14, column: 2 }, end: { line: 14, column: 12 } },
          1: { start: { line: 40, column: 0 }, end: { line: 40, column: 4 } }
        },
        s: { 0: 0, 1: 0 }
      }
    }));

    const mapping = mapCoverageToNodes(graphNodes(), records, workspaceRoot);

    expect(mapping.nodeIds).toEqual([]);
    expect(mapping.sequence).toEqual([]);
    expect(mapping.uncoveredNodeIds).toEqual([
      'src/panel.ts',
      'src/panel.ts#renderPanel',
      'src/panel.ts#savePanel'
    ]);
  });

  it('leaves files the coverage report never mentions out of the dark zone', () => {
    const records = parseCoverageJson(JSON.stringify({
      files: {
        'python/other.py': { executed_lines: [1], missing_lines: [] }
      }
    }));

    const mapping = mapCoverageToNodes(graphNodes(), records, workspaceRoot);

    // An uninstrumented file is not evidence that no test ran it, so nothing
    // in the TS graph may be darkened by a Python-only report.
    expect(mapping.uncoveredNodeIds).toEqual([]);
    expect(mapping.nodeIds).toEqual([]);
  });

  it('keeps a node covered when one report hits it and another reports it empty', () => {
    const mapping = mapCoverageToNodes(
      graphNodes(),
      [
        { path: 'C:\\repo\\src\\panel.ts', executedLines: [] },
        { path: 'C:\\repo\\src\\panel.ts', executedLines: [13] }
      ],
      workspaceRoot
    );

    expect(mapping.nodeIds).toEqual([
      'src/panel.ts',
      'src/panel.ts#renderPanel'
    ]);
    expect(mapping.uncoveredNodeIds).toEqual(['src/panel.ts#savePanel']);
  });

  it('parses coverage.py JSON using one-based executed lines', () => {
    const records = parseCoverageJson(JSON.stringify({
      meta: { version: '7.0' },
      files: {
        'python/app.py': {
          executed_lines: [1, 7, 8],
          missing_lines: [10]
        }
      }
    }));

    expect(records).toEqual([{
      path: 'python/app.py',
      executedLines: [0, 6, 7]
    }]);
  });

  it('maps a failing reporter stack frame to its file and narrowest function', () => {
    const failures = parseTestFailures([
      'FAIL tests/panel.test.ts > panel > renders state',
      'AssertionError: expected true to be false',
      '    at renderPanel (C:\\repo\\src\\panel.ts:15:3)'
    ].join('\n'));
    const mapping = mapFailuresToNodes(graphNodes(), failures, workspaceRoot);

    expect(failures[0]).toMatchObject({
      testName: 'tests/panel.test.ts > panel > renders state',
      source: 'test'
    });
    expect(mapping.testErrorNodeIds).toEqual([
      'src/panel.ts',
      'src/panel.ts#renderPanel'
    ]);
    expect(mapping.failures['src/panel.ts#renderPanel']?.[0]).toMatchObject({
      testName: 'tests/panel.test.ts > panel > renders state',
      line: 14,
      character: 2
    });
  });

  it('maps a pytest stack frame to its Python class method', () => {
    const failures = parseTestFailures([
      '________________ test_parse_file ________________',
      'RuntimeError: parser crashed',
      'python/app.py:8: in parse_file'
    ].join('\n'));
    const mapping = mapFailuresToNodes(
      pythonGraphNodes(),
      failures,
      workspaceRoot
    );

    expect(mapping.testErrorNodeIds).toEqual([
      'python/app.py',
      'python/app.py#Parser.parse_file'
    ]);
    expect(mapping.failures['python/app.py#Parser.parse_file']?.[0])
      .toMatchObject({
        testName: 'test_parse_file',
        line: 7,
        character: 0
      });
  });

  it('transitions covered nodes from verifying to passing', () => {
    const nodes = graphNodes();
    const store = new NodeStateStore(nodes);
    const tracker = new TestRunTracker(nodes, store, workspaceRoot);

    tracker.begin(['src/panel.ts']);
    expect(nodes[0].state).toBe('verifying');
    const result = tracker.prepare(
      [{ path: 'src/panel.ts', executedLines: [13] }],
      [],
      0
    );
    const snapshot = tracker.complete(result);

    expect(nodes[0].state).toBe('passing');
    expect(nodes[1].state).toBe('passing');
    expect(nodes[0].lastVerifiedAt).not.toBeNull();
    expect(snapshot).toMatchObject({
      phase: 'complete',
      outcome: 'passed'
    });
  });

  it('transitions a failing test path from verifying to error', () => {
    const nodes = graphNodes();
    const store = new NodeStateStore(nodes);
    const tracker = new TestRunTracker(nodes, store, workspaceRoot);
    tracker.begin(['src/panel.ts']);
    const result = tracker.prepare(
      [{ path: 'src/panel.ts', executedLines: [13] }],
      parseTestFailures([
        'FAIL panel > renders',
        'AssertionError: wrong value',
        ' at renderPanel (C:\\repo\\src\\panel.ts:15:3)'
      ].join('\n')),
      1
    );

    tracker.complete(result);

    expect(nodes[0].state).toBe('error');
    expect(nodes[1].state).toBe('error');
    expect(nodes[1].errorSources).toEqual(['test']);
  });

  it('records uncaught test-process exceptions as runtime errors', () => {
    const nodes = graphNodes();
    const store = new NodeStateStore(nodes);
    const tracker = new TestRunTracker(nodes, store, workspaceRoot);
    tracker.begin(['src/panel.ts']);
    const result = tracker.prepare(
      [{ path: 'src/panel.ts', executedLines: [13] }],
      parseTestFailures([
        'Uncaught Exception: socket closed',
        ' at renderPanel (C:\\repo\\src\\panel.ts:15:3)'
      ].join('\n')),
      1
    );

    tracker.complete(result);

    expect(nodes[1].state).toBe('error');
    expect(nodes[1].errorSources).toEqual(['runtime']);
    expect(result.failureMapping.failures[nodes[1].id]?.[0]?.source)
      .toBe('runtime');
  });

  it('clears runtime independently while preserving another error source', () => {
    const nodes = graphNodes();
    const store = new NodeStateStore(nodes);
    const tracker = new TestRunTracker(nodes, store, workspaceRoot);
    store.addError([nodes[0].id], 'diagnostic');
    const failed = tracker.prepare(
      [{ path: 'src/panel.ts', executedLines: [13] }],
      parseTestFailures([
        'Uncaught Error: crash',
        ' at renderPanel (C:\\repo\\src\\panel.ts:15:3)'
      ].join('\n')),
      1
    );
    tracker.complete(failed);
    expect(nodes[0].errorSources).toEqual(['diagnostic', 'runtime']);

    const passed = tracker.prepare(
      [{ path: 'src/panel.ts', executedLines: [13] }],
      [],
      0
    );
    tracker.complete(passed);

    expect(nodes[0].state).toBe('error');
    expect(nodes[0].errorSources).toEqual(['diagnostic']);
  });

  it('keeps save-triggered tests disabled by default and creates safe defaults', () => {
    const settings = resolveTestSettings();
    const plans = createTestCommandPlans(
      settings,
      new Set(['ts', 'py']),
      { devDependencies: { jest: '^30.0.0' } }
    );

    expect(DEFAULT_RUN_TESTS_ON_SAVE).toBe(false);
    expect(settings.runTestsOnSave).toBe(false);
    expect(plans).toEqual([
      {
        language: 'javascript',
        command: 'npx --no-install jest --coverage --coverageReporters=json',
        coverageFile: 'coverage/coverage-final.json'
      },
      {
        language: 'python',
        command: 'python -m coverage run -m pytest',
        afterCommand: 'python -m coverage json -o "coverage.json"',
        coverageFile: 'coverage.json'
      }
    ]);
  });
});

function graphNodes(): GraphNode[] {
  return [
    node('src/panel.ts', 'file', 0, 60),
    node('src/panel.ts#renderPanel', 'function', 10, 20),
    node('src/panel.ts#savePanel', 'function', 30, 45)
  ];
}

function pythonGraphNodes(): GraphNode[] {
  return [
    {
      ...node('python/app.py', 'file', 0, 30),
      path: 'python/app.py',
      lang: 'py'
    },
    {
      ...node('python/app.py#Parser.parse_file', 'function', 5, 14),
      path: 'python/app.py',
      lang: 'py'
    }
  ];
}

function node(
  id: string,
  kind: GraphNode['kind'],
  startLine: number,
  endLine: number
): GraphNode {
  return {
    id,
    kind,
    path: 'src/panel.ts',
    name: id.split('#').at(-1) ?? 'panel.ts',
    range: { startLine, endLine },
    lang: 'ts',
    state: 'idle',
    errorSources: [],
    editingAgents: [],
    annotation: { auto: null, manual: null },
    lastVerifiedAt: null
  };
}
