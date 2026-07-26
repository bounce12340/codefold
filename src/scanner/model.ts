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

export interface FileGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface SourceFile {
  path: string;
  content: string;
}

export interface WebviewGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  seed: number;
  truncated: boolean;
  totalFiles: number;
  layout: WorkspaceLayout;
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
