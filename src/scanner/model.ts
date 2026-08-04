export type SupportedLanguage = 'ts' | 'js' | 'py';
export type NodeKind = 'folder' | 'file' | 'function';
export type NodeState =
  | 'idle'
  | 'editing'
  | 'dirty'
  | 'verifying'
  | 'passing'
  | 'error';

export interface GraphNode {
  id: string;
  kind: NodeKind;
  path: string;
  name: string;
  range: { startLine: number; endLine: number };
  lang: SupportedLanguage;
  state: NodeState;
  errorSources: Array<'test' | 'diagnostic' | 'runtime' | 'agent'>;
  editingAgents: string[];
  annotation: {
    auto: string | null;
    manual: string | null;
  };
  lastVerifiedAt: string | null;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: 'import' | 'call' | 'contains';
}

export interface AgentInfo {
  id: string;
  name: string;
  parentId: string | null;
  badge: string;
  status: 'active' | 'idle' | 'done';
}

export interface AgentSnapshot extends AgentInfo {
  workAreas: string[];
}

export type DiagnosticSeverity = 'error' | 'warning' | 'information' | 'hint';

export interface NodeDiagnostic {
  id: string;
  fileId: string;
  source: string;
  message: string;
  severity: DiagnosticSeverity;
  range: {
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
  };
}

export type NodeDiagnostics = Record<string, NodeDiagnostic[]>;

export interface AgentReportDetail {
  id: string;
  agentId: string;
  agentName: string;
  message: string;
  fileId: string;
  nodeId: string;
  createdAt: string;
}

export type NodeAgentReports = Record<string, AgentReportDetail[]>;

export interface TestFailureDetail {
  id: string;
  testName: string;
  message: string;
  stack: string;
  source: 'test' | 'runtime';
  fileId: string;
  line: number;
  character: number;
}

export type NodeTestFailures = Record<string, TestFailureDetail[]>;

export interface TestRunSnapshot {
  phase: 'idle' | 'running' | 'flow' | 'complete';
  outcome: 'passed' | 'failed' | null;
  sequence: string[];
  failures: NodeTestFailures;
  message: string | null;
  /**
   * Instrumented but never executed. Rendered as a dimmed "dark zone" overlay
   * rather than a NodeState, so it never competes with the state precedence.
   */
  uncovered: string[];
}

export interface StatusSummary {
  activeAgents: number;
  editingNodes: number;
  errorNodes: number;
  passingNodes: number;
}

export interface WebviewSettings {
  flashAnimations: boolean;
}

export interface NodeStateUpdate {
  nodes: GraphNode[];
  agents: AgentSnapshot[];
  diagnostics?: NodeDiagnostics;
  testRun?: TestRunSnapshot;
  agentReports?: NodeAgentReports;
  summary?: StatusSummary;
  settings?: WebviewSettings;
}

export interface FileGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface SourceFile {
  path: string;
  content: string;
}

export interface DependencyCycle {
  id: string;
  nodeIds: string[];
}

export interface DependencyCoupling {
  nodeId: string;
  fanIn: number;
  fanOut: number;
}

export interface DependencyHealth {
  cycles: DependencyCycle[];
  cyclicNodeIds: string[];
  cyclicEdgeKeys: string[];
  coupling: DependencyCoupling[];
  /** Same analysis collapsed onto folders, for the default collapsed view. */
  folderCycles: DependencyCycle[];
  cyclicFolderIds: string[];
  cyclicFolderEdgeKeys: string[];
}

export interface WebviewGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  seed: number;
  truncated: boolean;
  totalFiles: number;
  totalFunctions: number;
  functionCounts: Record<string, number>;
  layout: WorkspaceLayout;
  dependencyHealth: DependencyHealth;
}

export interface FunctionGraphPayload {
  fileId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface LayoutPoint {
  x: number;
  y: number;
}

export interface GroupLayout extends LayoutPoint {
  expanded: boolean;
}

export interface WorkspaceLayout {
  version: 1;
  groups: Record<string, GroupLayout>;
  files: Record<string, LayoutPoint>;
}
