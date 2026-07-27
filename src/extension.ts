import * as vscode from 'vscode';
import type {
  FunctionGraphPayload,
  GraphEdge,
  GraphNode,
  NodeStateUpdate,
  WebviewGraph,
  WorkspaceLayout
} from './scanner/model';
import { AgentRegistry } from './agents/agentRegistry';
import type { AgentHookEvent } from './agents/events';
import { AgentHookServer } from './agents/hookServer';
import {
  emptyWorkspaceLayout,
  readWorkspaceLayout,
  writeWorkspaceLayout
} from './layout/workspaceLayout';
import { writeWorkspaceNote } from './scanner/notes';
import { scanWorkspaceRoot } from './scanner/scanWorkspace';
import { NodeStateStore } from './state/nodeStateMachine';
import { findChangedLineRange } from './state/textChanges';

const MAX_FILES = 2_000;
const VIEW_TYPES = {
  '2d': 'codefold.canvas',
  '3d': 'codefold.graph3d'
} as const;

type ViewMode = keyof typeof VIEW_TYPES;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('CodeFold');
  const agentRegistry = new AgentRegistry();
  let phase2Runtime: Phase2Runtime | undefined;
  const hookServer = new AgentHookServer({
    log: (message) => output.appendLine(`[agent hook] ${message}`),
    onEvent: async (event) => {
      if (phase2Runtime) {
        await phase2Runtime.handleAgentEvent(event);
        return;
      }
      agentRegistry.apply(event, eventWorkArea(event));
      output.appendLine(
        `[agent hook] Accepted ${event.type} for ${event.agent_id}; `
        + 'no 2D canvas is currently open.'
      );
    }
  });

  try {
    const info = await hookServer.start();
    output.appendLine(`Agent hook endpoint: ${info.url}`);
    output.appendLine(`Agent hook token: ${info.token}`);
    output.appendLine(
      'The endpoint is bound only to 127.0.0.1; see docs/agent-hooks.md for hook setup.'
    );
  } catch (error) {
    const detail = formatError(error);
    output.appendLine(`Could not start the CodeFold agent hook endpoint: ${detail}`);
    output.show(true);
  }

  context.subscriptions.push(
    output,
    { dispose: () => void hookServer.stop().catch((error) => {
      output.appendLine(`Could not stop the CodeFold agent hook endpoint: ${formatError(error)}`);
    }) },
    registerGraphCommand(
      context,
      output,
      'codefold.open',
      '2d',
      agentRegistry,
      (runtime) => {
        phase2Runtime = runtime;
      }
    ),
    registerGraphCommand(context, output, 'codefold.open3d', '3d')
  );

  if (vscode.workspace.getConfiguration('codefold').get<boolean>('openOnStartup', false)) {
    void vscode.commands.executeCommand('codefold.open').then(undefined, (error: unknown) => {
      output.appendLine(`Could not open the CodeFold canvas on startup: ${formatError(error)}`);
    });
  }
}

export function deactivate(): void {
  // VS Code disposes resources registered in the extension context.
}

function registerGraphCommand(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  command: string,
  mode: ViewMode,
  agentRegistry?: AgentRegistry,
  setPhase2Runtime?: (runtime: Phase2Runtime | undefined) => void
): vscode.Disposable {
  let currentPanel: vscode.WebviewPanel | undefined;
  let receiveSubscription: vscode.Disposable | undefined;
  let localPhase2Runtime: Phase2Runtime | undefined;
  return vscode.commands.registerCommand(command, async () => {
    if (currentPanel === undefined) {
      currentPanel = createPanel(context, mode);
      currentPanel.onDidDispose(
        () => {
          receiveSubscription?.dispose();
          receiveSubscription = undefined;
          localPhase2Runtime?.dispose();
          localPhase2Runtime = undefined;
          setPhase2Runtime?.(undefined);
          currentPanel = undefined;
        },
        undefined,
        context.subscriptions
      );
    } else {
      currentPanel.reveal(vscode.ViewColumn.Beside);
    }

    const panel = currentPanel;
    receiveSubscription?.dispose();
    localPhase2Runtime?.dispose();
    localPhase2Runtime = undefined;
    setPhase2Runtime?.(undefined);
    let ready = false;
    let pendingGraph: WebviewGraph | undefined;
    let pendingFunctionNodes: GraphNode[] = [];
    let pendingFunctionEdges: GraphEdge[] = [];
    let fileUris = new Map<string, vscode.Uri>();
    let functionStartLines = new Map<string, number>();
    let noteTargets = new Map<string, NoteTarget>();
    let layoutRoot: string | undefined;
    receiveSubscription = panel.webview.onDidReceiveMessage(
      async (message: unknown) => {
        if (!isWebviewMessage(message)) {
          output.appendLine('Ignored an invalid message from the CodeFold webview.');
          return;
        }
        if (message.type === 'ready') {
          ready = true;
          if (pendingGraph !== undefined) {
            await panel.webview.postMessage({ type: 'graph', graph: pendingGraph });
            if (localPhase2Runtime) {
              await localPhase2Runtime.postSnapshot();
            }
          }
          return;
        }
        if (message.type === 'loadFunctions') {
          if (mode !== '2d' || pendingGraph === undefined) {
            output.appendLine(
              `Ignored a function request before the 2D graph was ready: ${message.fileId}`
            );
            return;
          }
          const localNodes = pendingFunctionNodes.filter(
            (node) => node.path === message.fileId
          );
          const localIds = new Set(localNodes.map((node) => node.id));
          const edges = pendingFunctionEdges.filter((edge) =>
            (edge.kind === 'contains' && edge.from === message.fileId)
            || (
              edge.kind === 'call'
              && (localIds.has(edge.from) || localIds.has(edge.to))
            )
          );
          const relatedIds = new Set(
            edges.flatMap((edge) => [edge.from, edge.to])
          );
          const payload: FunctionGraphPayload = {
            fileId: message.fileId,
            nodes: pendingFunctionNodes.filter(
              (node) => localIds.has(node.id) || relatedIds.has(node.id)
            ),
            edges
          };
          await panel.webview.postMessage({ type: 'functions', payload });
          output.appendLine(
            `Supplied ${localNodes.length} lazy function nodes for ${message.fileId}.`
          );
          return;
        }
        if (message.type === 'saveLayout') {
          if (mode !== '2d' || layoutRoot === undefined) {
            const detail = 'CodeFold has no local workspace available for layout storage.';
            output.appendLine(detail);
            output.show(true);
            await panel.webview.postMessage({
              type: 'layoutSaveError',
              message: detail
            });
            return;
          }
          try {
            const saved = await writeWorkspaceLayout(layoutRoot, message.layout);
            if (pendingGraph !== undefined) {
              pendingGraph.layout = saved;
            }
            await panel.webview.postMessage({ type: 'layoutSaved' });
            output.appendLine('Saved 2D canvas layout.');
          } catch (error) {
            const detail = formatError(error);
            output.appendLine(`Could not save CodeFold layout: ${detail}`);
            output.show(true);
            await panel.webview.postMessage({
              type: 'layoutSaveError',
              message: detail
            });
          }
          return;
        }
        if (message.type === 'saveAnnotation') {
          const target = noteTargets.get(message.nodeId);
          if (target === undefined) {
            const detail =
              `Webview requested an annotation save for unknown node: ${message.nodeId}`;
            output.appendLine(detail);
            await panel.webview.postMessage({
              type: 'annotationSaveError',
              nodeId: message.nodeId,
              message: detail
            });
            return;
          }
          try {
            const manual = await writeWorkspaceNote(
              target.workspaceRoot,
              target.relativePath,
              message.manual
            );
            const graphNode = pendingGraph?.nodes.find(
              (node) => node.id === message.nodeId
            );
            if (graphNode !== undefined) {
              graphNode.annotation.manual = manual;
            }
            await panel.webview.postMessage({
              type: 'annotationSaved',
              nodeId: message.nodeId,
              manual
            });
            output.appendLine(`Saved annotation for ${message.nodeId}.`);
          } catch (error) {
            const detail = formatError(error);
            output.appendLine(
              `Could not save annotation for ${message.nodeId}: ${detail}`
            );
            output.show(true);
            await panel.webview.postMessage({
              type: 'annotationSaveError',
              nodeId: message.nodeId,
              message: detail
            });
            void vscode.window.showErrorMessage(
              `CodeFold could not save the annotation: ${detail}`
            );
          }
          return;
        }
        const uri = fileUris.get(message.nodeId);
        if (uri === undefined) {
          output.appendLine(`Webview requested unknown node: ${message.nodeId}`);
          return;
        }
        try {
          const document = await vscode.workspace.openTextDocument(uri);
          const editor = await vscode.window.showTextDocument(document, {
            preview: false,
            preserveFocus: false
          });
          const startLine = functionStartLines.get(message.nodeId);
          if (startLine !== undefined) {
            const position = new vscode.Position(startLine, 0);
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(
              new vscode.Range(position, position),
              vscode.TextEditorRevealType.InCenterIfOutsideViewport
            );
          }
        } catch (error) {
          const detail = formatError(error);
          output.appendLine(`Could not open ${uri.toString()}: ${detail}`);
          void vscode.window.showErrorMessage(
            `CodeFold could not open the file: ${detail}`
          );
        }
      }
    );
    panel.webview.html = mode === '2d'
      ? get2dWebviewHtml(panel.webview, context.extensionUri)
      : get3dWebviewHtml(panel.webview, context.extensionUri);
    output.appendLine(
      `[${new Date().toISOString()}] Scanning workspace for the ${mode.toUpperCase()} view.`
    );

    try {
      const result = await scanWorkspace(
        output,
        context,
        mode === '2d'
      );
      pendingGraph = result.graph;
      pendingFunctionNodes = result.functionNodes;
      pendingFunctionEdges = result.functionEdges;
      fileUris = result.fileUris;
      functionStartLines = result.functionStartLines;
      noteTargets = result.noteTargets;
      layoutRoot = result.layoutRoot;
      if (mode === '2d' && agentRegistry) {
        localPhase2Runtime = createPhase2Runtime({
          panel,
          graph: pendingGraph,
          functionNodes: pendingFunctionNodes,
          fileUris,
          fileContents: result.fileContents,
          agentRegistry,
          output
        });
        setPhase2Runtime?.(localPhase2Runtime);
      }
      if (ready) {
        await panel.webview.postMessage({ type: 'graph', graph: pendingGraph });
        if (localPhase2Runtime) {
          await localPhase2Runtime.postSnapshot();
        }
      }
      output.appendLine(
        `Rendered ${pendingGraph.nodes.length} file nodes and `
        + `${pendingGraph.edges.length} import edges in the ${mode.toUpperCase()} view; `
        + `${pendingGraph.totalFunctions} function nodes are available lazily.`
      );
    } catch (error) {
      const detail = formatError(error);
      output.appendLine(`Workspace scan failed: ${detail}`);
      output.show(true);
      void vscode.window.showErrorMessage(`CodeFold workspace scan failed: ${detail}`);
      await panel.webview.postMessage({ type: 'error', message: detail });
    }
  });
}

function createPanel(
  context: vscode.ExtensionContext,
  mode: ViewMode
): vscode.WebviewPanel {
  return vscode.window.createWebviewPanel(
    VIEW_TYPES[mode],
    mode === '2d' ? 'CodeFold' : 'CodeFold 3D',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, 'dist')
      ]
    }
  );
}

async function scanWorkspace(
  output: vscode.OutputChannel,
  context: vscode.ExtensionContext,
  includeFunctions: boolean
): Promise<{
  graph: WebviewGraph;
  functionNodes: GraphNode[];
  functionEdges: GraphEdge[];
  fileUris: Map<string, vscode.Uri>;
  functionStartLines: Map<string, number>;
  noteTargets: Map<string, NoteTarget>;
  fileContents: Map<string, string>;
  layoutRoot: string | undefined;
}> {
  const folders = vscode.workspace.workspaceFolders;
  if (folders === undefined || folders.length === 0) {
    throw new Error('Open a folder or workspace before running CodeFold: Open.');
  }

  const combinedNodes: GraphNode[] = [];
  const combinedEdges: GraphEdge[] = [];
  const combinedFunctionNodes: GraphNode[] = [];
  const combinedFunctionEdges: GraphEdge[] = [];
  const fileUris = new Map<string, vscode.Uri>();
  const functionStartLines = new Map<string, number>();
  const noteTargets = new Map<string, NoteTarget>();
  const fileContents = new Map<string, string>();
  let totalFiles = 0;
  let truncated = false;
  let layout = emptyWorkspaceLayout();
  let layoutRoot: string | undefined;
  const multipleRoots = folders.length > 1;

  for (const folder of folders) {
    if (folder.uri.scheme !== 'file') {
      output.appendLine(
        `Skipped non-local workspace folder ${folder.name} (${folder.uri.scheme}).`
      );
      continue;
    }
    if (layoutRoot === undefined) {
      layoutRoot = folder.uri.fsPath;
      try {
        layout = await readWorkspaceLayout(layoutRoot);
      } catch (error) {
        output.appendLine(`Could not load CodeFold layout: ${formatError(error)}`);
        output.show(true);
      }
    }
    const result = await scanWorkspaceRoot(folder.uri.fsPath, {
      maxFiles: MAX_FILES + 1,
      includeFunctions,
      wasmDirectory: vscode.Uri.joinPath(
        context.extensionUri,
        'dist',
        'tree-sitter'
      ).fsPath,
      onError: (message) => {
        output.appendLine(message);
        if (message.startsWith('Could not load CodeFold notes:')) {
          output.show(true);
        }
      }
    });
    totalFiles += result.totalFiles;
    truncated ||= result.truncated;
    const prefix = multipleRoots ? `${folder.name}/` : '';
    for (const node of result.nodes) {
      const id = `${prefix}${node.id}`;
      const displayPath = `${prefix}${node.path}`;
      combinedNodes.push({ ...node, id, path: displayPath });
      fileUris.set(
        id,
        vscode.Uri.joinPath(folder.uri, ...node.path.split('/'))
      );
      noteTargets.set(id, {
        workspaceRoot: folder.uri.fsPath,
        relativePath: node.path
      });
      const content = result.sourceContents[node.path];
      if (content !== undefined) {
        fileContents.set(id, content);
      }
    }
    for (const edge of result.edges) {
      combinedEdges.push({
        ...edge,
        from: `${prefix}${edge.from}`,
        to: `${prefix}${edge.to}`
      });
    }
    for (const node of result.functionNodes) {
      const id = `${prefix}${node.id}`;
      const displayPath = `${prefix}${node.path}`;
      combinedFunctionNodes.push({ ...node, id, path: displayPath });
      fileUris.set(
        id,
        vscode.Uri.joinPath(folder.uri, ...node.path.split('/'))
      );
      functionStartLines.set(id, node.range.startLine);
    }
    for (const edge of result.functionEdges) {
      combinedFunctionEdges.push({
        ...edge,
        from: `${prefix}${edge.from}`,
        to: `${prefix}${edge.to}`
      });
    }
  }

  combinedNodes.sort((left, right) => left.id.localeCompare(right.id));
  const visibleNodes = combinedNodes.slice(0, MAX_FILES);
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const visibleEdges = combinedEdges.filter(
    (edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to)
  );
  const visibleFunctionNodes = combinedFunctionNodes.filter(
    (node) => visibleIds.has(node.path)
  );
  const visibleFunctionIds = new Set(
    visibleFunctionNodes.map((node) => node.id)
  );
  const visibleFunctionEdges = combinedFunctionEdges.filter((edge) =>
    (
      edge.kind === 'contains'
      && visibleIds.has(edge.from)
      && visibleFunctionIds.has(edge.to)
    )
    || (
      edge.kind === 'call'
      && visibleFunctionIds.has(edge.from)
      && visibleFunctionIds.has(edge.to)
    )
  );
  truncated ||= combinedNodes.length > MAX_FILES || totalFiles > MAX_FILES;

  if (truncated) {
    output.appendLine(
      `Workspace contains ${totalFiles} supported files; showing the first ${MAX_FILES}.`
    );
  }
  if (visibleNodes.length === 0) {
    output.appendLine('No supported .ts, .tsx, .js, .jsx, or .py files were found.');
  }

  for (const nodeId of [...fileUris.keys()]) {
    if (!visibleIds.has(nodeId) && !visibleFunctionIds.has(nodeId)) {
      fileUris.delete(nodeId);
      noteTargets.delete(nodeId);
      functionStartLines.delete(nodeId);
      fileContents.delete(nodeId);
    }
  }
  const functionCounts: Record<string, number> = {};
  for (const node of visibleFunctionNodes) {
    functionCounts[node.path] = (functionCounts[node.path] ?? 0) + 1;
  }
  if (visibleFunctionNodes.length > 2_000) {
    output.appendLine(
      `Workspace contains ${visibleFunctionNodes.length} function nodes; `
      + 'keeping the file layer as the default and supplying functions only on expansion.'
    );
  }
  const seed = hashStrings([
    ...visibleNodes.map((node) => node.id),
    ...visibleEdges.map((edge) => `${edge.from}->${edge.to}`)
  ]);
  return {
    graph: {
      nodes: visibleNodes,
      edges: visibleEdges,
      seed,
      truncated,
      totalFiles,
      totalFunctions: visibleFunctionNodes.length,
      functionCounts,
      layout
    },
    functionNodes: visibleFunctionNodes,
    functionEdges: visibleFunctionEdges,
    fileUris,
      functionStartLines,
      noteTargets,
      fileContents,
      layoutRoot
  };
}

interface Phase2Runtime extends vscode.Disposable {
  handleAgentEvent(event: AgentHookEvent): Promise<void>;
  postSnapshot(): Promise<void>;
}

interface Phase2RuntimeOptions {
  panel: vscode.WebviewPanel;
  graph: WebviewGraph;
  functionNodes: GraphNode[];
  fileUris: Map<string, vscode.Uri>;
  fileContents: Map<string, string>;
  agentRegistry: AgentRegistry;
  output: vscode.OutputChannel;
}

function createPhase2Runtime(options: Phase2RuntimeOptions): Phase2Runtime {
  const {
    panel,
    graph,
    functionNodes,
    fileUris,
    fileContents,
    agentRegistry,
    output
  } = options;
  const allNodes = [...graph.nodes, ...functionNodes];
  const nodeById = new Map(allNodes.map((node) => [node.id, node]));
  const functionsByPath = new Map<string, GraphNode[]>();
  for (const node of functionNodes) {
    const siblings = functionsByPath.get(node.path) ?? [];
    siblings.push(node);
    functionsByPath.set(node.path, siblings);
  }
  const fileIdByFsPath = new Map<string, string>();
  for (const file of graph.nodes) {
    const uri = fileUris.get(file.id);
    if (uri) {
      fileIdByFsPath.set(normalizeFsPath(uri.fsPath), file.id);
    }
  }

  let disposed = false;
  const postState = async (nodes: GraphNode[]): Promise<void> => {
    if (disposed) {
      return;
    }
    const update: NodeStateUpdate = {
      nodes,
      agents: agentRegistry.snapshots()
    };
    try {
      await panel.webview.postMessage({ type: 'stateUpdate', update });
    } catch (error) {
      output.appendLine(`Could not update Phase 2 webview state: ${formatError(error)}`);
    }
  };
  const stateStore = new NodeStateStore(allNodes, (nodes) => {
    void postState(nodes);
  });

  const watcher = vscode.workspace.createFileSystemWatcher(
    '**/*.{ts,tsx,js,jsx,py}',
    true,
    false,
    true
  );
  const watcherChange = watcher.onDidChange((uri) => {
    const fileId = fileIdByFsPath.get(normalizeFsPath(uri.fsPath));
    if (!fileId) {
      output.appendLine(
        `Ignored a changed source outside the scanned graph (including .gitignore): ${uri.fsPath}`
      );
      return;
    }
    void vscode.workspace.fs.readFile(uri).then(
      (bytes) => {
        const current = Buffer.from(bytes).toString('utf8');
        const previous = fileContents.get(fileId);
        fileContents.set(fileId, current);
        const changedRange = previous === undefined
          ? undefined
          : findChangedLineRange(previous, current);
        const changedFunctions = changedRange === undefined
          ? []
          : (functionsByPath.get(fileId) ?? []).filter((node) =>
            rangesOverlap(
              node.range.startLine,
              node.range.endLine,
              changedRange.startLine,
              changedRange.endLine
            )
          );
        stateStore.markFileChange([
          fileId,
          ...changedFunctions.map((node) => node.id)
        ]);
        output.appendLine(
          `FileSystemWatcher detected a change in ${fileId}; `
          + (
            previous === undefined
              ? 'no prior text snapshot was available, so only the file node was marked.'
              : `${changedFunctions.length} function range(s) were matched.`
          )
        );
      },
      (error) => {
        stateStore.markFileChange([fileId]);
        output.appendLine(
          `Could not read changed file ${fileId}; marked only the file node: ${formatError(error)}`
        );
        output.show(true);
      }
    );
  });
  const documentChange = vscode.workspace.onDidChangeTextDocument((event) => {
    const fileId = fileIdByFsPath.get(normalizeFsPath(event.document.uri.fsPath));
    if (!fileId || event.contentChanges.length === 0) {
      return;
    }
    const functions = functionsByPath.get(fileId) ?? [];
    const changedFunctions = functions.filter((node) =>
      event.contentChanges.some((change) =>
        rangesOverlap(
          node.range.startLine,
          node.range.endLine,
          change.range.start.line,
          change.range.end.line
        )
      )
    );
    const changedIds = [fileId, ...changedFunctions.map((node) => node.id)];
    stateStore.markFileChange(changedIds);

    // The VS Code change event supplies line precision while a hook may only
    // identify the file. Attribute overlapping functions to agents already
    // editing that file; otherwise editingAgents intentionally stays empty.
    for (const agent of agentRegistry.snapshots()) {
      if (
        agent.status === 'active'
        && agent.workAreas.some((area) => area === fileId || area.startsWith(`${fileId}#`))
      ) {
        stateStore.startAgentEdit(
          [fileId, ...changedFunctions.map((node) => node.id)],
          agent.id
        );
      }
    }
  });

  const resolveTargets = (
    event: AgentHookEvent
  ): { nodeIds: string[]; workArea?: string } => {
    if (event.type === 'agent_spawn' || event.type === 'agent_done') {
      return { nodeIds: [] };
    }
    let fileId: string | undefined;
    let exactNode: GraphNode | undefined;
    if (event.node_id) {
      exactNode = nodeById.get(event.node_id);
      fileId = exactNode?.path;
    }
    if (!fileId && event.path) {
      fileId = resolveFileId(event.path, graph.nodes, fileIdByFsPath);
    }
    if (!fileId) {
      return { nodeIds: [], workArea: eventWorkArea(event) };
    }

    const localFunctions = functionsByPath.get(fileId) ?? [];
    if (!exactNode && event.symbol) {
      exactNode = nodeById.get(`${fileId}#${event.symbol}`);
    }
    if (!exactNode && event.line) {
      const line = event.line - 1;
      exactNode = localFunctions
        .filter((node) => node.range.startLine <= line && node.range.endLine >= line)
        .sort((left, right) =>
          (left.range.endLine - left.range.startLine)
          - (right.range.endLine - right.range.startLine)
        )[0];
    }

    const nodeIds = [fileId];
    if (exactNode?.kind === 'function') {
      nodeIds.push(exactNode.id);
    }
    if (event.type === 'agent_edit_end') {
      for (const node of localFunctions) {
        if (node.editingAgents.includes(event.agent_id)) {
          nodeIds.push(node.id);
        }
      }
    }
    return {
      nodeIds: [...new Set(nodeIds)],
      workArea: exactNode?.id ?? fileId
    };
  };

  // Restore active hook ownership if the canvas was reopened after events
  // arrived. Raw paths are resolved where possible; unknown paths stay in the
  // agent sidebar but do not silently mutate an unrelated node.
  for (const agent of agentRegistry.snapshots()) {
    if (agent.status !== 'active') {
      continue;
    }
    for (const workArea of agent.workAreas) {
      const node = nodeById.get(workArea);
      const fileId = node?.path ?? resolveFileId(workArea, graph.nodes, fileIdByFsPath);
      if (fileId) {
        stateStore.startAgentEdit(
          node?.kind === 'function' ? [fileId, node.id] : [fileId],
          agent.id
        );
      }
    }
  }

  return {
    async handleAgentEvent(event: AgentHookEvent): Promise<void> {
      const { nodeIds, workArea } = resolveTargets(event);
      agentRegistry.apply(event, workArea);

      if (event.type === 'agent_edit_start') {
        stateStore.startAgentEdit(nodeIds, event.agent_id);
      } else if (event.type === 'agent_edit_end') {
        stateStore.endAgentEdit(nodeIds, event.agent_id);
      } else if (event.type === 'agent_done') {
        stateStore.finishAgent(event.agent_id);
      } else if (event.type === 'agent_report' && event.level === 'error') {
        stateStore.addError(nodeIds, 'agent');
      }

      if (
        nodeIds.length === 0
        && (event.type === 'agent_edit_start'
          || event.type === 'agent_edit_end'
          || event.type === 'agent_report')
      ) {
        output.appendLine(
          `[agent hook] Accepted ${event.type} for ${event.agent_id}, but could not `
          + `resolve target ${eventWorkArea(event) ?? '(missing path/node_id)'}.`
        );
      } else {
        output.appendLine(
          `[agent hook] Processed ${event.type} for ${event.agent_id}`
          + (workArea ? ` at ${workArea}.` : '.')
        );
      }
      await postState([]);
    },
    async postSnapshot(): Promise<void> {
      await postState(allNodes.map(cloneGraphNode));
    },
    dispose(): void {
      disposed = true;
      stateStore.dispose();
      watcherChange.dispose();
      documentChange.dispose();
      watcher.dispose();
    }
  };
}

function resolveFileId(
  candidate: string,
  files: readonly GraphNode[],
  fileIdByFsPath: ReadonlyMap<string, string>
): string | undefined {
  const absoluteMatch = fileIdByFsPath.get(normalizeFsPath(candidate));
  if (absoluteMatch) {
    return absoluteMatch;
  }
  const relative = candidate.replaceAll('\\', '/').replace(/^\.\//, '');
  const matches = files.filter((node) =>
    node.id === relative
    || node.path === relative
    || node.path.endsWith(`/${relative}`)
  );
  return matches.length === 1 ? matches[0].id : undefined;
}

function normalizeFsPath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function rangesOverlap(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number
): boolean {
  return leftStart <= rightEnd && rightStart <= leftEnd;
}

function eventWorkArea(event: AgentHookEvent): string | undefined {
  if (event.type === 'agent_spawn' || event.type === 'agent_done') {
    return undefined;
  }
  return event.node_id
    ?? (event.path && event.symbol ? `${event.path}#${event.symbol}` : event.path);
}

function cloneGraphNode(node: GraphNode): GraphNode {
  return {
    ...node,
    range: { ...node.range },
    errorSources: [...node.errorSources],
    editingAgents: [...node.editingAgents],
    annotation: { ...node.annotation }
  };
}

function get2dWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri
): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'webview2d.js')
  );
  const nonce = createNonce();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>CodeFold</title>
  <style nonce="${nonce}">
    :root {
      --sidebar-width: 310px;
      --neutral: color-mix(in srgb, var(--vscode-descriptionForeground) 70%, #7891a8);
      --panel: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--neutral));
      --panel-strong: color-mix(in srgb, var(--vscode-editor-background) 76%, var(--neutral));
      --state-editing: var(--vscode-editorWarning-foreground, #cca700);
      --state-dirty: color-mix(in srgb, var(--state-editing) 58%, #4f4218);
      --state-error: var(--vscode-errorForeground, #f14c4c);
      --state-passing: var(--vscode-testing-iconPassed, #73c991);
      --state-neutral: var(--neutral);
      --dependency-edge: color-mix(in srgb, var(--neutral) 72%, transparent);
      --dependency-edge-strong:
        color-mix(in srgb, var(--neutral) 90%, var(--vscode-foreground));
    }
    body.vscode-light, body.vscode-high-contrast-light {
      --state-editing:
        color-mix(in srgb, var(--vscode-editorWarning-foreground, #bf8803) 72%, #594000);
      --state-dirty:
        color-mix(in srgb, var(--vscode-editorWarning-foreground, #bf8803) 40%, #453a12);
      --state-error:
        color-mix(in srgb, var(--vscode-errorForeground, #a1260d) 82%, #5f1309);
      --state-passing:
        color-mix(in srgb, var(--vscode-testing-iconPassed, #388a34) 72%, #164c25);
      --state-neutral: color-mix(in srgb, var(--neutral) 68%, #344f66);
    }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    body {
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    button, textarea { font: inherit; }
    [hidden] { display: none !important; }
    #canvas {
      position: fixed; inset: 0 var(--sidebar-width) 0 0; overflow: hidden;
      cursor: grab;
      background-image:
        radial-gradient(circle, color-mix(in srgb, var(--neutral) 28%, transparent) 1px, transparent 1px);
      background-size: 24px 24px;
      touch-action: none;
    }
    #canvas.panning { cursor: grabbing; }
    #viewport {
      position: absolute; left: 0; top: 0; width: 1px; height: 1px;
      transform-origin: 0 0; will-change: transform;
    }
    #edge-layer, #node-layer {
      position: absolute; left: 0; top: 0; width: 1px; height: 1px; overflow: visible;
    }
    #edge-layer { pointer-events: none; }
    .dependency {
      fill: none; stroke: var(--dependency-edge);
      stroke-linecap: round; vector-effect: non-scaling-stroke;
    }
    .dependency.aggregate { stroke: var(--dependency-edge-strong); }
    .dependency.call {
      stroke: color-mix(in srgb, var(--dependency-edge-strong) 84%, transparent);
      stroke-dasharray: 7 4;
    }
    .dependency.contains {
      stroke: color-mix(in srgb, var(--dependency-edge-strong) 82%, transparent);
      stroke-width: 2.2px;
      stroke-dasharray: none;
    }
    .dependency.phase1-edge { animation: edge-in 160ms ease-out both; }
    @keyframes edge-in { from { opacity: 0; } to { opacity: 1; } }
    #dependency-arrow-shape { fill: var(--dependency-edge-strong); }
    .edge-count {
      fill: var(--vscode-foreground); stroke: var(--vscode-editor-background);
      stroke-width: 4px; paint-order: stroke; text-anchor: middle;
      font: 600 12px var(--vscode-font-family); pointer-events: none;
    }
    .folder-group {
      position: absolute; left: 0; top: 0; overflow: hidden;
      border: 1px solid color-mix(in srgb, var(--neutral) 85%, transparent);
      border-radius: 10px;
      background: color-mix(in srgb, var(--panel) 94%, transparent);
      box-shadow: 0 6px 22px color-mix(in srgb, #000 24%, transparent);
      transition: width 180ms ease, height 180ms ease, box-shadow 150ms ease;
      will-change: transform, width, height;
    }
    .folder-group.expanded {
      background: color-mix(in srgb, var(--vscode-editor-background) 93%, var(--neutral));
      box-shadow: 0 9px 30px color-mix(in srgb, #000 30%, transparent);
    }
    .folder-group.dragging { box-shadow: 0 12px 35px color-mix(in srgb, #000 42%, transparent); }
    .folder-header {
      position: absolute; z-index: 2; left: 0; right: 0; top: 0; height: 48px;
      display: grid; grid-template-columns: 18px minmax(0, 1fr) auto;
      align-items: center; gap: 8px; width: 100%; padding: 0 14px;
      color: var(--vscode-foreground); text-align: left; cursor: grab;
      border: 0; border-bottom: 1px solid transparent;
      background: var(--panel-strong);
    }
    .expanded > .folder-header {
      border-bottom-color: color-mix(in srgb, var(--neutral) 55%, transparent);
    }
    .folder-header:focus-visible {
      outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px;
    }
    .folder-chevron {
      font-size: 23px; line-height: 1; color: var(--vscode-descriptionForeground);
      transform: rotate(0); transition: transform 160ms ease;
    }
    .expanded .folder-chevron { transform: rotate(90deg); }
    .folder-name {
      min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-size: 14px; font-weight: 700;
    }
    .folder-count {
      color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 600;
    }
    .folder-files { position: absolute; inset: 0; }
    .file-card {
      position: absolute; left: 0; top: 0; width: 200px; height: 100px;
      overflow: hidden; cursor: pointer; user-select: none;
      border: 1px solid color-mix(in srgb, var(--neutral) 82%, transparent);
      border-radius: 7px; background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      box-shadow: 0 3px 10px color-mix(in srgb, #000 25%, transparent);
      transition: border-color 120ms ease, box-shadow 120ms ease;
      will-change: transform;
    }
    .file-card:hover {
      border-color: color-mix(in srgb, var(--neutral) 62%, var(--vscode-foreground));
      box-shadow: 0 5px 14px color-mix(in srgb, #000 34%, transparent);
    }
    .file-card.selected {
      outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px;
    }
    .file-card.dragging { cursor: grabbing; z-index: 5; }
    .file-card:focus-visible { outline: 2px solid var(--vscode-focusBorder); }
    .file-card.node-state-editing, .function-card.node-state-editing {
      border-color: var(--state-editing);
      border-width: 2px;
      animation: editing-flash 820ms ease-in-out infinite alternate;
    }
    .file-card.node-state-dirty, .function-card.node-state-dirty {
      border-color: var(--state-dirty);
      border-width: 1px 1px 1px 4px;
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--state-dirty) 58%, transparent),
        0 4px 13px color-mix(in srgb, #000 26%, transparent);
    }
    .file-card.node-state-error, .function-card.node-state-error {
      border-color: var(--state-error);
      border-width: 2px;
    }
    .file-card.node-state-passing, .function-card.node-state-passing {
      border-color: var(--state-passing);
      border-width: 2px;
    }
    .file-card.node-state-verifying, .function-card.node-state-verifying {
      border-color: var(--state-neutral);
    }
    .file-card.node-conflict, .function-card.node-conflict {
      outline: 2px dotted var(--vscode-foreground); outline-offset: 2px;
    }
    @keyframes editing-flash {
      from {
        box-shadow: 0 0 0 1px color-mix(in srgb, var(--state-editing) 35%, transparent),
          0 3px 10px color-mix(in srgb, #000 25%, transparent);
      }
      to {
        box-shadow: 0 0 0 4px color-mix(in srgb, var(--state-editing) 38%, transparent),
          0 0 22px color-mix(in srgb, var(--state-editing) 52%, transparent);
      }
    }
    .file-title {
      display: grid; grid-template-columns: 20px minmax(0, 1fr) auto;
      align-items: center; gap: 6px;
      height: 34px; padding: 0 9px;
      background: color-mix(in srgb, var(--panel-strong) 88%, transparent);
      border-bottom: 1px solid color-mix(in srgb, var(--neutral) 42%, transparent);
    }
    .file-name {
      min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-weight: 650;
    }
    .file-function-toggle {
      display: grid; place-items: center; width: 20px; height: 22px; padding: 0;
      color: var(--vscode-descriptionForeground); background: transparent;
      border: 0; border-radius: 3px; cursor: pointer;
      transform: rotate(0); transition: transform 160ms ease, opacity 120ms ease;
    }
    .file-function-toggle:hover {
      color: var(--vscode-foreground);
      background: color-mix(in srgb, var(--neutral) 18%, transparent);
    }
    .file-function-toggle:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
    .file-function-toggle.expanded { transform: rotate(90deg); }
    .file-function-toggle.loading { opacity: .55; }
    .file-function-toggle:disabled { cursor: default; opacity: .28; }
    .language-badge {
      flex: 0 0 auto; padding: 2px 5px; border-radius: 4px;
      color: var(--vscode-descriptionForeground);
      background: color-mix(in srgb, var(--neutral) 20%, transparent);
      font-size: 10px; font-weight: 750; text-transform: uppercase;
    }
    .file-annotation {
      height: 66px; padding: 8px 9px; overflow: hidden;
      color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.45;
      white-space: normal; overflow-wrap: anywhere;
    }
    .node-state-lamp {
      position: absolute; z-index: 3; top: 5px; right: 5px;
      width: 8px; height: 8px; border-radius: 50%;
      border: 1px solid color-mix(in srgb, var(--vscode-editor-background) 70%, transparent);
      background: var(--state-neutral);
    }
    .node-state-editing .node-state-lamp { background: var(--state-editing); }
    .node-state-dirty .node-state-lamp {
      width: 12px; height: 5px; border-radius: 1px;
      background: var(--state-dirty);
    }
    .node-state-error .node-state-lamp { background: var(--state-error); }
    .node-state-passing .node-state-lamp { background: var(--state-passing); }
    .agent-badges {
      position: absolute; z-index: 4; right: 7px; bottom: 6px;
      display: flex; align-items: center; gap: 4px;
    }
    .agent-badge {
      display: inline-grid; place-items: center; width: 15px; height: 15px;
      color: #fff; font-size: 8px; font-weight: 800;
      filter: drop-shadow(0 1px 2px color-mix(in srgb, #000 42%, transparent));
    }
    .agent-badge.tone-violet { background: #8b6fd6; }
    .agent-badge.tone-magenta { background: #b45fae; }
    .agent-badge.tone-copper { background: #98634f; }
    .agent-badge.shape-diamond { clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%); }
    .agent-badge.shape-hexagon {
      clip-path: polygon(25% 4%, 75% 4%, 100% 50%, 75% 96%, 25% 96%, 0 50%);
    }
    .agent-badge.shape-triangle { clip-path: polygon(50% 0, 100% 100%, 0 100%); }
    .agent-badge.shape-square { border-radius: 2px; }
    .function-card {
      position: absolute; z-index: 7; width: 190px; height: 46px; padding: 7px 9px;
      overflow: visible; cursor: pointer; user-select: none;
      border: 1px solid color-mix(in srgb, var(--neutral) 72%, transparent);
      border-radius: 6px;
      color: var(--vscode-foreground);
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      box-shadow: 0 3px 12px color-mix(in srgb, #000 24%, transparent);
      opacity: 0; transform: translateX(-8px) scale(.98);
      transition: opacity 160ms ease, transform 160ms ease, border-color 120ms ease;
      will-change: opacity, transform;
    }
    .function-card::before {
      content: ""; position: absolute; right: 100%; top: 50%; width: 16px;
      border-top: 2px solid color-mix(in srgb, var(--dependency-edge-strong) 82%, transparent);
    }
    .function-card.function-child-continuation::after {
      content: ""; position: absolute; right: calc(100% + 14px);
      top: calc(-50% - 10px); height: calc(100% + 10px);
      border-left: 2px solid color-mix(in srgb, var(--dependency-edge-strong) 82%, transparent);
    }
    .function-card.visible { opacity: 1; transform: translateX(0) scale(1); }
    .function-card.closing { opacity: 0; transform: translateX(-8px) scale(.98); }
    .function-card:hover {
      border-color: color-mix(in srgb, var(--neutral) 55%, var(--vscode-foreground));
    }
    .function-card.node-state-editing:hover { border-color: var(--state-editing); }
    .function-card.node-state-dirty:hover { border-color: var(--state-dirty); }
    .function-card.node-state-error:hover { border-color: var(--state-error); }
    .function-card.node-state-passing:hover { border-color: var(--state-passing); }
    .function-card.node-conflict.selected {
      outline: 2px dotted var(--vscode-foreground); outline-offset: 2px;
    }
    .function-card.selected {
      outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px;
    }
    .function-title {
      display: flex; align-items: baseline; gap: 4px; min-width: 0;
    }
    .function-owner {
      flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis;
      color: var(--vscode-descriptionForeground); font-size: 9px; white-space: nowrap;
    }
    .function-name {
      flex: 1 1 auto; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-size: 12px; font-weight: 680;
    }
    .function-range {
      margin-top: 3px; color: var(--vscode-descriptionForeground); font-size: 10px;
    }
    #status, #warning, #layout-warning, #tooltip, #reset-view {
      position: fixed; z-index: 20; border-radius: 5px;
      border: 1px solid var(--vscode-widget-border, transparent);
    }
    #status, #warning, #layout-warning {
      left: 10px; padding: 6px 9px; pointer-events: none;
      background: color-mix(in srgb, var(--vscode-editor-background) 90%, transparent);
    }
    #status { top: 10px; }
    #warning {
      top: 48px; max-width: min(600px, calc(100vw - var(--sidebar-width) - 24px));
      color: var(--vscode-editorWarning-foreground);
    }
    #layout-warning {
      top: 84px; max-width: min(600px, calc(100vw - var(--sidebar-width) - 24px));
      color: var(--vscode-errorForeground);
    }
    #tooltip {
      max-width: min(520px, 60vw); padding: 8px 10px; pointer-events: none;
      white-space: pre-wrap; overflow-wrap: anywhere;
      background: var(--vscode-editorHoverWidget-background);
      color: var(--vscode-editorHoverWidget-foreground);
      box-shadow: 0 5px 20px color-mix(in srgb, #000 35%, transparent);
    }
    #reset-view {
      right: calc(var(--sidebar-width) + 14px); bottom: 14px; padding: 7px 11px;
      color: var(--vscode-button-foreground); background: var(--vscode-button-background);
      cursor: pointer;
    }
    #reset-view:hover { background: var(--vscode-button-hoverBackground); }
    #sidebar {
      position: fixed; z-index: 30; top: 0; right: 0; bottom: 0;
      width: var(--sidebar-width); padding: 16px; overflow: auto;
      background: var(--vscode-sideBar-background);
      border-left: 1px solid var(--vscode-sideBar-border, var(--vscode-widget-border));
    }
    #sidebar h2 { margin: 0 0 14px; font-size: 17px; }
    #sidebar-empty { color: var(--vscode-descriptionForeground); line-height: 1.5; }
    .field { display: block; margin: 0 0 13px; }
    .field-label {
      display: block; margin-bottom: 4px; color: var(--vscode-descriptionForeground);
      font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
    }
    .field-value { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
    #manual-annotation {
      width: 100%; min-height: 112px; padding: 7px; resize: vertical;
      color: var(--vscode-input-foreground); background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
    }
    .sidebar-actions { display: flex; gap: 8px; margin-top: 8px; }
    .sidebar-actions button {
      padding: 6px 10px; border: 0; cursor: pointer;
      color: var(--vscode-button-foreground); background: var(--vscode-button-background);
    }
    .sidebar-actions button:hover { background: var(--vscode-button-hoverBackground); }
    .sidebar-actions button:disabled { cursor: default; opacity: .55; }
    #save-status {
      min-height: 18px; margin-top: 8px;
      color: var(--vscode-descriptionForeground); font-size: 12px;
    }
    #save-status.error { color: var(--vscode-errorForeground); }
    #agent-panel {
      margin-top: 18px; padding-top: 14px;
      border-top: 1px solid var(--vscode-sideBar-border, var(--vscode-widget-border));
    }
    #agent-panel h2 { margin-bottom: 8px; }
    #agent-tree, #agent-tree ul { margin: 0; padding-left: 17px; list-style: none; }
    #agent-tree { padding-left: 0; }
    .agent-entry { margin: 5px 0; }
    .agent-line { display: flex; align-items: center; gap: 7px; min-width: 0; }
    .agent-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; font-weight: 650; }
    .agent-status, .agent-work {
      color: var(--vscode-descriptionForeground); font-size: 11px;
    }
    .agent-work { margin: 2px 0 0 22px; overflow-wrap: anywhere; }
    #agent-conflicts {
      margin: 8px 0 0; color: var(--vscode-foreground); font-size: 12px;
      border-left: 3px dotted var(--vscode-foreground); padding-left: 8px;
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        scroll-behavior: auto !important; animation-duration: .001ms !important;
        animation-iteration-count: 1 !important; transition-duration: .001ms !important;
      }
      .file-card.node-state-editing, .function-card.node-state-editing {
        animation: editing-breathe-reduced 3s ease-in-out infinite !important;
      }
      @keyframes editing-breathe-reduced {
        from { box-shadow: 0 0 0 1px color-mix(in srgb, var(--state-editing) 28%, transparent); }
        to { box-shadow: 0 0 0 2px color-mix(in srgb, var(--state-editing) 40%, transparent); }
      }
    }
  </style>
</head>
<body>
  <main id="canvas" aria-label="2D file dependency canvas">
    <div id="viewport">
      <svg id="edge-layer" aria-hidden="true">
        <defs>
          <marker
            id="dependency-arrow"
            viewBox="0 0 10 10"
            refX="10"
            refY="5"
            markerWidth="10"
            markerHeight="10"
            markerUnits="userSpaceOnUse"
            orient="auto"
          >
            <path id="dependency-arrow-shape" d="M 0 1 L 10 5 L 0 9 Z"></path>
          </marker>
        </defs>
      </svg>
      <div id="node-layer"></div>
    </div>
  </main>
  <div id="status" role="status">Loading workspace graph…</div>
  <div id="warning" role="alert" hidden></div>
  <div id="layout-warning" role="alert" hidden></div>
  <div id="tooltip" role="tooltip" hidden></div>
  <button id="reset-view" type="button" title="Fit all folders in the canvas">Reset view</button>
  <aside id="sidebar" aria-label="Selected node details">
    <h2>Node details</h2>
    <p id="sidebar-empty">Expand a folder, then select a file card. Use its title arrow to show functions.</p>
    <div id="node-details" hidden>
      <div class="field"><span class="field-label">Name</span><p id="node-name" class="field-value"></p></div>
      <div class="field"><span class="field-label">Path</span><p id="node-path" class="field-value"></p></div>
      <div class="field"><span class="field-label">Language</span><p id="node-language" class="field-value"></p></div>
      <div class="field"><span class="field-label">State</span><p id="node-state" class="field-value"></p></div>
      <div class="field"><span class="field-label">Editing agents</span><p id="node-agents" class="field-value"></p></div>
      <div class="field"><span class="field-label">Error sources</span><p id="node-errors" class="field-value"></p></div>
      <div id="node-conflict" class="field" hidden>Potential conflict: multiple agents are editing this node.</div>
      <div class="field">
        <span class="field-label">Automatic annotation</span>
        <p id="auto-annotation" class="field-value"></p>
      </div>
      <label class="field">
        <span class="field-label">Manual annotation</span>
        <textarea id="manual-annotation" placeholder="Add a workspace note…"></textarea>
      </label>
      <div class="sidebar-actions">
        <button id="save-annotation" type="button">Save annotation</button>
        <button id="open-file" type="button">Open file</button>
      </div>
      <div id="save-status" role="status"></div>
    </div>
    <section id="agent-panel" aria-label="Agent hierarchy">
      <h2>Agents</h2>
      <p id="agent-empty" class="field-value">No agent hook events received.</p>
      <ul id="agent-tree"></ul>
      <p id="agent-conflicts" hidden></p>
    </section>
  </aside>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function get3dWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri
): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js')
  );
  const nonce = createNonce();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>CodeFold</title>
  <style nonce="${nonce}">
    html, body, #scene { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
    #scene { position: fixed; inset: 0 306px 0 0; width: auto; }
    #status, #warning, #tooltip, #reset-view {
      position: fixed; z-index: 2; padding: 6px 9px; border-radius: 4px;
      background: color-mix(in srgb, var(--vscode-editor-background) 88%, transparent);
      border: 1px solid var(--vscode-widget-border, transparent);
    }
    #status, #warning, #tooltip {
      pointer-events: none;
    }
    #status { top: 10px; left: 10px; }
    #warning { top: 48px; left: 10px; color: var(--vscode-editorWarning-foreground); display: none; }
    #tooltip { display: none; max-width: min(520px, 70vw); white-space: pre-wrap; overflow-wrap: anywhere; }
    #reset-view {
      right: 326px; bottom: 12px; color: var(--vscode-button-foreground);
      background: var(--vscode-button-background); cursor: pointer;
    }
    #reset-view:hover { background: var(--vscode-button-hoverBackground); }
    #sidebar {
      position: fixed; z-index: 3; top: 0; right: 0; bottom: 0; width: 290px;
      box-sizing: border-box; padding: 16px; overflow: auto;
      background: color-mix(in srgb, var(--vscode-sideBar-background) 96%, transparent);
      border-left: 1px solid var(--vscode-sideBar-border, var(--vscode-widget-border));
    }
    #sidebar h2 { margin: 0 0 14px; font-size: 17px; }
    #sidebar-empty { color: var(--vscode-descriptionForeground); line-height: 1.45; }
    #node-details[hidden] { display: none; }
    .field { margin: 0 0 13px; }
    .field-label {
      display: block; margin-bottom: 4px; color: var(--vscode-descriptionForeground);
      font-size: 12px; font-weight: 600; text-transform: uppercase;
    }
    .field-value { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
    #manual-annotation {
      width: 100%; min-height: 112px; box-sizing: border-box; resize: vertical;
      padding: 7px; color: var(--vscode-input-foreground);
      background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border);
      font: inherit;
    }
    .sidebar-actions { display: flex; gap: 8px; margin-top: 8px; }
    .sidebar-actions button {
      padding: 6px 10px; border: 0; color: var(--vscode-button-foreground);
      background: var(--vscode-button-background); cursor: pointer;
    }
    .sidebar-actions button:hover { background: var(--vscode-button-hoverBackground); }
    .sidebar-actions button:disabled { cursor: default; opacity: 0.55; }
    #save-status { min-height: 18px; margin-top: 8px; color: var(--vscode-descriptionForeground); font-size: 12px; }
    #save-status.error { color: var(--vscode-errorForeground); }
  </style>
</head>
<body>
  <div id="scene" aria-label="3D file dependency graph"></div>
  <div id="status" role="status">Loading workspace graph…</div>
  <div id="warning" role="alert"></div>
  <div id="tooltip"></div>
  <button id="reset-view" type="button" title="Re-center all nodes">Reset view</button>
  <aside id="sidebar" aria-label="Selected node details">
    <h2>Node details</h2>
    <p id="sidebar-empty">Select a capsule to inspect it. Double-click a capsule to open its file.</p>
    <div id="node-details" hidden>
      <div class="field">
        <span class="field-label">Name</span>
        <p id="node-name" class="field-value"></p>
      </div>
      <div class="field">
        <span class="field-label">Path</span>
        <p id="node-path" class="field-value"></p>
      </div>
      <div class="field">
        <span class="field-label">Language</span>
        <p id="node-language" class="field-value"></p>
      </div>
      <div class="field">
        <span class="field-label">Automatic annotation</span>
        <p id="auto-annotation" class="field-value"></p>
      </div>
      <label class="field">
        <span class="field-label">Manual annotation</span>
        <textarea id="manual-annotation" placeholder="Add a workspace note…"></textarea>
      </label>
      <div class="sidebar-actions">
        <button id="save-annotation" type="button">Save annotation</button>
        <button id="open-file" type="button">Open file</button>
      </div>
      <div id="save-status" role="status"></div>
    </div>
  </aside>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let index = 0; index < 32; index += 1) {
    value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return value;
}

function hashStrings(values: readonly string[]): number {
  let hash = 0x811c9dc5;
  for (const value of values) {
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return hash >>> 0;
}

function isWebviewMessage(
  message: unknown
): message is
  | { type: 'ready' }
  | { type: 'openFile'; nodeId: string }
  | { type: 'loadFunctions'; fileId: string }
  | { type: 'saveAnnotation'; nodeId: string; manual: string }
  | { type: 'saveLayout'; layout: WorkspaceLayout } {
  if (typeof message !== 'object' || message === null || !('type' in message)) {
    return false;
  }
  const type = (message as { type: unknown }).type;
  if (type === 'ready') {
    return true;
  }
  if (
    type === 'saveLayout'
    && 'layout' in message
    && isWorkspaceLayout((message as { layout: unknown }).layout)
  ) {
    return true;
  }
  if (
    (type === 'openFile' || type === 'saveAnnotation')
    && 'nodeId' in message
    && typeof (message as { nodeId: unknown }).nodeId === 'string'
  ) {
    return type === 'openFile'
      || (
        'manual' in message
        && typeof (message as { manual: unknown }).manual === 'string'
      );
  }
  if (
    type === 'loadFunctions'
    && 'fileId' in message
    && typeof (message as { fileId: unknown }).fileId === 'string'
  ) {
    return true;
  }
  return false;
}

function isWorkspaceLayout(value: unknown): value is WorkspaceLayout {
  if (
    typeof value !== 'object'
    || value === null
    || !('version' in value)
    || value.version !== 1
    || !('groups' in value)
    || !('files' in value)
  ) {
    return false;
  }
  return isLayoutRecord(value.groups, true) && isLayoutRecord(value.files, false);
}

function isLayoutRecord(value: unknown, requireExpanded: boolean): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((entry) =>
    typeof entry === 'object'
    && entry !== null
    && 'x' in entry
    && typeof entry.x === 'number'
    && Number.isFinite(entry.x)
    && 'y' in entry
    && typeof entry.y === 'number'
    && Number.isFinite(entry.y)
    && (
      !requireExpanded
      || ('expanded' in entry && typeof entry.expanded === 'boolean')
    )
  );
}

interface NoteTarget {
  workspaceRoot: string;
  relativePath: string;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
