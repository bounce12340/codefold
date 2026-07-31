import type {
  CoverageRecord,
  CoverageMapping
} from './coverage';
import { mapCoverageToNodes } from './coverage';
import type { ParsedFailure, FailureMapping } from './failures';
import { mapFailuresToNodes } from './failures';
import type {
  GraphNode,
  TestRunSnapshot
} from '../scanner/model';
import { NodeStateStore } from '../state/nodeStateMachine';

export interface PreparedTestResult {
  coverage: CoverageMapping;
  failureMapping: FailureMapping;
  passed: boolean;
  message: string;
}

export class TestRunTracker {
  private current: TestRunSnapshot = {
    phase: 'idle',
    outcome: null,
    sequence: [],
    failures: {},
    message: null,
    uncovered: []
  };

  constructor(
    private readonly nodes: readonly GraphNode[],
    private readonly stateStore: NodeStateStore,
    private readonly workspaceRoot: string
  ) {}

  begin(candidateNodeIds: readonly string[]): TestRunSnapshot {
    this.current = {
      phase: 'running',
      outcome: null,
      sequence: [],
      failures: {},
      message: 'Tests are running.',
      uncovered: []
    };
    this.stateStore.setVerifying(candidateNodeIds);
    return this.snapshot();
  }

  prepare(
    coverageRecords: readonly CoverageRecord[],
    failures: readonly ParsedFailure[],
    exitCode: number
  ): PreparedTestResult {
    const coverage = mapCoverageToNodes(
      this.nodes,
      coverageRecords,
      this.workspaceRoot
    );
    const failureMapping = mapFailuresToNodes(
      this.nodes,
      failures,
      this.workspaceRoot
    );
    const failed = exitCode !== 0
      || failureMapping.testErrorNodeIds.length > 0
      || failureMapping.runtimeErrorNodeIds.length > 0;
    const message = failed
      ? `Tests failed with exit code ${exitCode}.`
      : `Tests passed; ${coverage.nodeIds.length} node(s) were covered.`;
    this.current = {
      phase: 'flow',
      outcome: null,
      sequence: [...coverage.sequence],
      failures: cloneFailures(failureMapping.failures),
      message,
      uncovered: [...coverage.uncoveredNodeIds]
    };
    this.stateStore.setVerifying(coverage.nodeIds);
    return { coverage, failureMapping, passed: !failed, message };
  }

  complete(result: PreparedTestResult): TestRunSnapshot {
    const allNodeIds = this.nodes.map((node) => node.id);
    this.stateStore.replaceErrorSource(
      'test',
      result.failureMapping.testErrorNodeIds
    );
    this.stateStore.replaceErrorSource(
      'runtime',
      result.failureMapping.runtimeErrorNodeIds
    );
    this.stateStore.clearVerification(allNodeIds);
    this.stateStore.setPassing(result.coverage.nodeIds);
    this.current = {
      phase: 'complete',
      outcome: result.passed ? 'passed' : 'failed',
      sequence: [...result.coverage.sequence],
      failures: cloneFailures(result.failureMapping.failures),
      message: result.message,
      uncovered: [...result.coverage.uncoveredNodeIds]
    };
    return this.snapshot();
  }

  fail(message: string): TestRunSnapshot {
    this.stateStore.clearVerification(this.nodes.map((node) => node.id));
    this.current = {
      phase: 'complete',
      outcome: 'failed',
      sequence: [],
      failures: {},
      message,
      uncovered: []
    };
    return this.snapshot();
  }

  snapshot(): TestRunSnapshot {
    return {
      ...this.current,
      sequence: [...this.current.sequence],
      failures: cloneFailures(this.current.failures),
      uncovered: [...this.current.uncovered]
    };
  }
}

function cloneFailures(
  failures: TestRunSnapshot['failures']
): TestRunSnapshot['failures'] {
  return Object.fromEntries(
    Object.entries(failures).map(([nodeId, details]) => [
      nodeId,
      details.map((detail) => ({ ...detail }))
    ])
  );
}
