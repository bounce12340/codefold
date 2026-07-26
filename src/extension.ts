import * as vscode from 'vscode';
import type {
  FunctionGraphPayload,
  GraphEdge,
  GraphNode,
  WebviewGraph,
  WorkspaceLayout
} from './scanner/model';
import {
  emptyWorkspaceLayout,
  readWorkspaceLayout,
  writeWorkspaceLayout
} from './layout/workspaceLayout';
import { writeWorkspaceNote } from './scanner/notes';
import { scanWorkspaceRoot } from './scanner/scanWorkspace';

const MAX_FILES = 2_000;
const VIEW_TYPES = {
  '2d': 'codefold.canvas',
  '3d': 'codefold.graph3d'
} as const;

type ViewMode = keyof typeof VIEW_TYPES;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('CodeFold');
  context.subscriptions.push(
    output,
    registerGraphCommand(context, output, 'codefold.open', '2d'),
    registerGraphCommand(context, output, 'codefold.open3d', '3d')
  );
}

export function deactivate(): void {
  // VS Code disposes resources registered in the extension context.
}

function registerGraphCommand(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  command: string,
  mode: ViewMode
): vscode.Disposable {
  let currentPanel: vscode.WebviewPanel | undefined;
  let receiveSubscription: vscode.Disposable | undefined;
  return vscode.commands.registerCommand(command, async () => {
    if (currentPanel === undefined) {
      currentPanel = createPanel(context, mode);
      currentPanel.onDidDispose(
        () => {
          receiveSubscription?.dispose();
          receiveSubscription = undefined;
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
      if (ready) {
        await panel.webview.postMessage({ type: 'graph', graph: pendingGraph });
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
    layoutRoot
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
      --dependency-edge: color-mix(in srgb, var(--neutral) 72%, transparent);
      --dependency-edge-strong:
        color-mix(in srgb, var(--neutral) 90%, var(--vscode-foreground));
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
      stroke: color-mix(in srgb, var(--dependency-edge) 72%, transparent);
      stroke-dasharray: 2 4;
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
    .function-card {
      position: absolute; z-index: 7; width: 190px; height: 46px; padding: 7px 9px;
      overflow: hidden; cursor: pointer; user-select: none;
      border: 1px solid color-mix(in srgb, var(--neutral) 72%, transparent);
      border-radius: 6px;
      color: var(--vscode-foreground);
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      box-shadow: 0 3px 12px color-mix(in srgb, #000 24%, transparent);
      opacity: 0; transform: translateX(-8px) scale(.98);
      transition: opacity 160ms ease, transform 160ms ease, border-color 120ms ease;
      will-change: opacity, transform;
    }
    .function-card.visible { opacity: 1; transform: translateX(0) scale(1); }
    .function-card.closing { opacity: 0; transform: translateX(-8px) scale(.98); }
    .function-card:hover {
      border-color: color-mix(in srgb, var(--neutral) 55%, var(--vscode-foreground));
    }
    .function-card.selected {
      outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px;
    }
    .function-name {
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
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        scroll-behavior: auto !important; animation-duration: .001ms !important;
        animation-iteration-count: 1 !important; transition-duration: .001ms !important;
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
