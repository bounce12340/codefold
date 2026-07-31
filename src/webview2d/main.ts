import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum
} from 'd3-force';
import {
  aggregateFolderEdges,
  groupFilesByFolder,
  mapFilesToFolders,
  type FolderGroup
} from '../graph/folders';
import type {
  AgentReportDetail,
  AgentSnapshot,
  FunctionGraphPayload,
  GraphEdge,
  GraphNode,
  GroupLayout,
  LayoutPoint,
  NodeDiagnostic,
  NodeDiagnostics,
  NodeAgentReports,
  NodeState,
  NodeStateUpdate,
  StatusSummary,
  TestFailureDetail,
  TestRunSnapshot,
  WebviewSettings,
  WebviewGraph,
  WorkspaceLayout
} from '../scanner/model';
import { AnnotationSaveTracker } from './annotationSaveTracker';
import { hasAgentConflict } from '../state/nodeStateMachine';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
};

interface ForceGroup extends SimulationNodeDatum {
  id: string;
  x: number;
  y: number;
}

interface ForceGroupLink extends SimulationLinkDatum<ForceGroup> {
  source: string | ForceGroup;
  target: string | ForceGroup;
}

interface GroupView {
  group: FolderGroup;
  x: number;
  y: number;
  width: number;
  height: number;
  expanded: boolean;
  element: HTMLDivElement;
  filesElement: HTMLDivElement;
  filePositions: Map<string, LayoutPoint>;
}

interface VisibleEdge {
  from: string;
  to: string;
  count: number;
  kind: GraphEdge['kind'];
}

interface FunctionView {
  node: GraphNode;
  groupId: string;
  position: LayoutPoint;
  element: HTMLDivElement;
}

interface EndpointBounds {
  x: number;
  y: number;
  halfWidth: number;
  halfHeight: number;
}

interface EdgeGeometry {
  start: LayoutPoint;
  sourceControl: LayoutPoint;
  targetControl: LayoutPoint;
  end: LayoutPoint;
}

const COLLAPSED_WIDTH = 240;
const COLLAPSED_HEIGHT = 84;
const FILE_WIDTH = 200;
const FILE_HEIGHT = 100;
const FILE_GAP_X = 16;
const FILE_GAP_Y = 16;
const FUNCTION_WIDTH = 190;
const FUNCTION_HEIGHT = 46;
const FUNCTION_GAP = 10;
const FUNCTION_PANEL_GAP = 16;
const GROUP_PADDING = 14;
const GROUP_HEADER_HEIGHT = 48;
const MIN_SCALE = 0.12;
const MAX_SCALE = 2.5;
const ARROW_SIZE_PX = 10;
const RECIPROCAL_EDGE_OFFSET_PX = 18;
const EDGE_LABEL_OFFSET_PX = 13;

const vscode = acquireVsCodeApi();
const canvas = requireElement<HTMLDivElement>('canvas');
const viewport = requireElement<HTMLDivElement>('viewport');
const edgeLayer = requireElement<SVGSVGElement>('edge-layer');
const dependencyArrow = requireElement<SVGMarkerElement>('dependency-arrow');
const nodeLayer = requireElement<HTMLDivElement>('node-layer');
const status = requireElement<HTMLDivElement>('status');
const stateSummary = requireElement<HTMLDivElement>('state-summary');
const warning = requireElement<HTMLDivElement>('warning');
const layoutWarning = requireElement<HTMLDivElement>('layout-warning');
const tooltip = requireElement<HTMLDivElement>('tooltip');
const resetViewButton = requireElement<HTMLButtonElement>('reset-view');
const runTestsButton = requireElement<HTMLButtonElement>('run-tests');
const sidebarEmpty = requireElement<HTMLParagraphElement>('sidebar-empty');
const nodeDetails = requireElement<HTMLDivElement>('node-details');
const nodeName = requireElement<HTMLParagraphElement>('node-name');
const nodePath = requireElement<HTMLParagraphElement>('node-path');
const nodeLanguage = requireElement<HTMLParagraphElement>('node-language');
const nodeState = requireElement<HTMLParagraphElement>('node-state');
const nodeAgents = requireElement<HTMLParagraphElement>('node-agents');
const nodeErrors = requireElement<HTMLParagraphElement>('node-errors');
const errorSourceField = requireElement<HTMLDivElement>('error-source-field');
const nodeErrorSourceList = requireElement<HTMLUListElement>('node-error-source-list');
const diagnosticField = requireElement<HTMLDivElement>('diagnostic-field');
const nodeDiagnostics = requireElement<HTMLUListElement>('node-diagnostics');
const testFailureField = requireElement<HTMLDivElement>('test-failure-field');
const nodeTestFailures = requireElement<HTMLUListElement>('node-test-failures');
const agentReportField = requireElement<HTMLDivElement>('agent-report-field');
const nodeAgentReports = requireElement<HTMLUListElement>('node-agent-reports');
const nodeConflict = requireElement<HTMLDivElement>('node-conflict');
const autoAnnotation = requireElement<HTMLParagraphElement>('auto-annotation');
const manualAnnotation = requireElement<HTMLTextAreaElement>('manual-annotation');
const saveAnnotationButton = requireElement<HTMLButtonElement>('save-annotation');
const openFileButton = requireElement<HTMLButtonElement>('open-file');
const saveStatus = requireElement<HTMLDivElement>('save-status');
const agentEmpty = requireElement<HTMLParagraphElement>('agent-empty');
const agentTree = requireElement<HTMLUListElement>('agent-tree');
const agentConflicts = requireElement<HTMLParagraphElement>('agent-conflicts');

let graph: WebviewGraph | undefined;
let groups: GroupView[] = [];
let groupById = new Map<string, GroupView>();
let fileById = new Map<string, GraphNode>();
let functionById = new Map<string, GraphNode>();
let functionEdges = new Map<string, GraphEdge>();
let functionViews = new Map<string, FunctionView>();
let pendingNodeStates = new Map<string, GraphNode>();
let agentsById = new Map<string, AgentSnapshot>();
let diagnosticsByNode = new Map<string, NodeDiagnostic[]>();
let agentReportsByNode = new Map<string, AgentReportDetail[]>();
let testRunSnapshot: TestRunSnapshot = {
  phase: 'idle',
  outcome: null,
  sequence: [],
  failures: {},
  message: null,
  uncovered: []
};
let uncoveredNodeIds = new Set<string>();
const loadedFunctionFiles = new Set<string>();
const loadingFunctionFiles = new Set<string>();
const expandedFunctionFiles = new Set<string>();
let folderByFileId = new Map<string, string>();
let selectedNodeId: string | undefined;
const annotationSaves = new AnnotationSaveTracker();
let camera = { x: 0, y: 0, scale: 1 };
let edgeFrame: number | undefined;
let panState:
  | { pointerId: number; startX: number; startY: number; cameraX: number; cameraY: number }
  | undefined;

resetViewButton.addEventListener('click', fitToContent);
runTestsButton.addEventListener('click', () => {
  runTestsButton.disabled = true;
  status.textContent = 'Starting configured tests…';
  vscode.postMessage({ type: 'runTests' });
});
saveAnnotationButton.addEventListener('click', saveSelectedAnnotation);
openFileButton.addEventListener('click', openSelectedFile);
manualAnnotation.addEventListener('input', previewManualAnnotation);
canvas.addEventListener('wheel', onWheel, { passive: false });
canvas.addEventListener('pointerdown', startPan);
canvas.addEventListener('pointermove', movePan);
canvas.addEventListener('pointerup', endPan);
canvas.addEventListener('pointercancel', endPan);
window.addEventListener('resize', () => {
  applyCamera();
  scheduleEdges();
});
window.addEventListener('message', receiveExtensionMessage);

vscode.postMessage({ type: 'ready' });

function receiveExtensionMessage(event: MessageEvent<unknown>): void {
  if (!isExtensionMessage(event.data)) {
    return;
  }
  if (event.data.type === 'error') {
    status.textContent = `Scan failed: ${event.data.message}`;
    return;
  }
  if (event.data.type === 'graph') {
    renderGraph(event.data.graph);
    return;
  }
  if (event.data.type === 'functions') {
    applyFunctionPayload(event.data.payload);
    return;
  }
  if (event.data.type === 'stateUpdate') {
    applyStateUpdate(event.data.update);
    return;
  }
  if (event.data.type === 'testRunError') {
    runTestsButton.disabled = false;
    status.textContent = `Test run failed: ${event.data.message}`;
    layoutWarning.textContent = event.data.message;
    layoutWarning.hidden = false;
    return;
  }
  if (event.data.type === 'annotationSaved') {
    applySavedAnnotation(event.data.nodeId, event.data.manual);
    return;
  }
  if (event.data.type === 'layoutSaved') {
    layoutWarning.hidden = true;
    return;
  }
  if (event.data.type === 'layoutSaveError') {
    layoutWarning.textContent = `Layout was not saved: ${event.data.message}`;
    layoutWarning.hidden = false;
    return;
  }
  annotationSaves.fail(event.data.nodeId);
  if (selectedNodeId === event.data.nodeId) {
    saveAnnotationButton.disabled = false;
    saveStatus.textContent = `Save failed: ${event.data.message}`;
    saveStatus.classList.add('error');
  }
}

function renderGraph(nextGraph: WebviewGraph): void {
  graph = nextGraph;
  clearGraph();
  const folderGroups = groupFilesByFolder(nextGraph.nodes);
  folderByFileId = mapFilesToFolders(folderGroups);
  fileById = new Map(nextGraph.nodes.map((node) => [node.id, node]));
  const positions = layoutFolderGroups(nextGraph, folderGroups, folderByFileId);

  groups = folderGroups.map((folderGroup) => {
    const saved = nextGraph.layout.groups[folderGroup.id];
    const position = saved ?? positions.get(folderGroup.id) ?? {
      x: 0,
      y: 0,
      expanded: false
    };
    return createGroupView(
      folderGroup,
      position.x,
      position.y,
      saved?.expanded ?? false,
      nextGraph.layout
    );
  });
  groupById = new Map(groups.map((entry) => [entry.group.id, entry]));
  for (const group of groups) {
    nodeLayer.append(group.element);
    updateGroupGeometry(group);
    if (group.expanded) {
      renderGroupFiles(group);
    }
  }

  status.textContent = `${groups.length} folders · ${nextGraph.nodes.length} files · `
    + `${nextGraph.totalFunctions} functions · ${nextGraph.edges.length} imports`;
  const warnings: string[] = [];
  if (nextGraph.truncated) {
    warnings.push(
      `showing the first 2,000 of ${nextGraph.totalFiles} supported files`
    );
  }
  if (nextGraph.totalFunctions > 2_000) {
    warnings.push('function layer is supplied lazily when a file arrow is expanded');
  }
  if (warnings.length > 0) {
    warning.textContent = `Large workspace: ${warnings.join('; ')}.`;
    warning.hidden = false;
  } else {
    warning.hidden = true;
  }
  drawEdges();
  requestAnimationFrame(fitToContent);
}

function layoutFolderGroups(
  sourceGraph: WebviewGraph,
  folderGroups: readonly FolderGroup[],
  folderMapping: ReadonlyMap<string, string>
): Map<string, GroupLayout> {
  const random = seededRandom(sourceGraph.seed);
  const forceGroups: ForceGroup[] = folderGroups.map((folderGroup) => {
    const angle = random() * Math.PI * 2;
    const radius = 100 + random() * Math.max(160, folderGroups.length * 26);
    return {
      id: folderGroup.id,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius
    };
  });
  const links: ForceGroupLink[] = aggregateFolderEdges(
    sourceGraph.edges,
    folderMapping
  ).map((edge) => ({
    source: edge.from,
    target: edge.to
  }));
  const simulation = forceSimulation(forceGroups)
    .randomSource(seededRandom(sourceGraph.seed ^ 0x9e3779b9))
    .force(
      'link',
      forceLink<ForceGroup, ForceGroupLink>(links)
        .id((node) => node.id)
        .distance(310)
        .strength(0.42)
    )
    .force('charge', forceManyBody().strength(-1_100).distanceMax(1_200))
    .force('center', forceCenter(0, 0))
    .force('collision', forceCollide(175).strength(1))
    .stop();
  const ticks = folderGroups.length > 300 ? 140 : 220;
  for (let index = 0; index < ticks; index += 1) {
    simulation.tick();
  }
  simulation.stop();

  return new Map(forceGroups.map((entry) => [
    entry.id,
    {
      x: Math.round(entry.x - COLLAPSED_WIDTH / 2),
      y: Math.round(entry.y - COLLAPSED_HEIGHT / 2),
      expanded: false
    }
  ]));
}

function createGroupView(
  folderGroup: FolderGroup,
  x: number,
  y: number,
  expanded: boolean,
  savedLayout: WorkspaceLayout
): GroupView {
  const element = document.createElement('div');
  element.className = 'folder-group';
  element.dataset.groupId = folderGroup.id;

  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'folder-header';
  header.title = `${expanded ? 'Collapse' : 'Expand'} ${folderGroup.name}`;
  header.innerHTML =
    `<span class="folder-chevron" aria-hidden="true">›</span>`
    + `<span class="folder-name"></span>`
    + `<span class="folder-count"></span>`;
  requireDescendant<HTMLElement>(header, '.folder-name').textContent = folderGroup.name;
  requireDescendant<HTMLElement>(header, '.folder-count').textContent =
    `${folderGroup.files.length} ${folderGroup.files.length === 1 ? 'file' : 'files'}`;
  element.append(header);

  const filesElement = document.createElement('div');
  filesElement.className = 'folder-files';
  element.append(filesElement);

  const filePositions = new Map<string, LayoutPoint>();
  for (const file of folderGroup.files) {
    const saved = savedLayout.files[file.id];
    if (saved !== undefined) {
      filePositions.set(file.id, { ...saved });
    }
  }
  const view: GroupView = {
    group: folderGroup,
    x,
    y,
    width: COLLAPSED_WIDTH,
    height: COLLAPSED_HEIGHT,
    expanded,
    element,
    filesElement,
    filePositions
  };

  let suppressClick = false;
  let drag:
    | { pointerId: number; startX: number; startY: number; originalX: number; originalY: number }
    | undefined;
  header.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originalX: view.x,
      originalY: view.y
    };
    suppressClick = false;
    header.setPointerCapture(event.pointerId);
    element.classList.add('dragging');
  });
  header.addEventListener('pointermove', (event) => {
    if (drag?.pointerId !== event.pointerId) {
      return;
    }
    const dx = (event.clientX - drag.startX) / camera.scale;
    const dy = (event.clientY - drag.startY) / camera.scale;
    if (Math.hypot(dx, dy) > 3) {
      suppressClick = true;
    }
    view.x = drag.originalX + dx;
    view.y = drag.originalY + dy;
    updateGroupGeometry(view);
    scheduleEdges();
  });
  const finishDrag = (event: PointerEvent): void => {
    if (drag?.pointerId !== event.pointerId) {
      return;
    }
    header.releasePointerCapture(event.pointerId);
    drag = undefined;
    element.classList.remove('dragging');
    if (suppressClick) {
      persistLayout();
    }
  };
  header.addEventListener('pointerup', finishDrag);
  header.addEventListener('pointercancel', finishDrag);
  header.addEventListener('click', () => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    toggleGroup(view);
  });
  return view;
}

function toggleGroup(group: GroupView): void {
  setGroupExpanded(group, !group.expanded, true);
}

function setGroupExpanded(
  group: GroupView,
  expanded: boolean,
  saveLayout: boolean
): void {
  if (group.expanded === expanded) {
    return;
  }
  group.expanded = expanded;
  updateGroupGeometry(group);
  if (group.expanded) {
    renderGroupFiles(group);
  } else {
    clearGroupFunctionViews(group.group.id);
    group.filesElement.replaceChildren();
  }
  const header = requireDescendant<HTMLButtonElement>(
    group.element,
    '.folder-header'
  );
  header.title = `${group.expanded ? 'Collapse' : 'Expand'} ${group.group.name}`;
  drawEdges();
  if (saveLayout) {
    persistLayout();
  }
}

function updateGroupGeometry(group: GroupView): void {
  if (group.expanded) {
    const base = baseGroupDimensions(group);
    group.width = base.width;
    group.height = base.height;
    for (const [fileIndex, file] of group.group.files.entries()) {
      if (!expandedFunctionFiles.has(file.id)) {
        continue;
      }
      const functionCount = graph?.functionCounts[file.id] ?? 0;
      if (functionCount === 0) {
        continue;
      }
      const panel = functionPanelPosition(group, fileIndex);
      group.width = Math.max(
        group.width,
        panel.x + FUNCTION_WIDTH + GROUP_PADDING
      );
      group.height = Math.max(
        group.height,
        panel.y
          + functionCount * FUNCTION_HEIGHT
          + Math.max(0, functionCount - 1) * FUNCTION_GAP
          + GROUP_PADDING
      );
    }
  } else {
    group.width = COLLAPSED_WIDTH;
    group.height = COLLAPSED_HEIGHT;
  }
  group.element.classList.toggle('expanded', group.expanded);
  group.element.style.width = `${group.width}px`;
  group.element.style.height = `${group.height}px`;
  group.element.style.transform = `translate(${group.x}px, ${group.y}px)`;
}

function renderGroupFiles(group: GroupView): void {
  clearGroupFunctionViews(group.group.id);
  group.filesElement.replaceChildren();
  const columns = fileGridColumns(group.group.files.length);
  const fileBounds = baseGroupDimensions(group);
  for (const [index, file] of group.group.files.entries()) {
    const defaultPosition = {
      x: GROUP_PADDING + (index % columns) * (FILE_WIDTH + FILE_GAP_X),
      y: GROUP_HEADER_HEIGHT + GROUP_PADDING
        + Math.floor(index / columns) * (FILE_HEIGHT + FILE_GAP_Y)
    };
    const position = group.filePositions.get(file.id) ?? defaultPosition;
    position.x = clamp(
      position.x,
      GROUP_PADDING,
      fileBounds.width - FILE_WIDTH - GROUP_PADDING
    );
    position.y = clamp(
      position.y,
      GROUP_HEADER_HEIGHT + GROUP_PADDING,
      fileBounds.height - FILE_HEIGHT - GROUP_PADDING
    );
    group.filePositions.set(file.id, position);
    group.filesElement.append(createFileCard(group, file, position));
  }
  for (const file of group.group.files) {
    if (expandedFunctionFiles.has(file.id) && loadedFunctionFiles.has(file.id)) {
      renderFileFunctions(group, file.id);
    }
  }
}

function baseGroupDimensions(group: GroupView): { width: number; height: number } {
  const columns = fileGridColumns(group.group.files.length);
  const rows = Math.ceil(group.group.files.length / columns);
  return {
    width:
      GROUP_PADDING * 2 + columns * FILE_WIDTH
      + Math.max(0, columns - 1) * FILE_GAP_X,
    height:
      GROUP_HEADER_HEIGHT + GROUP_PADDING + rows * FILE_HEIGHT
      + Math.max(0, rows - 1) * FILE_GAP_Y + GROUP_PADDING
  };
}

function functionPanelPosition(
  group: GroupView,
  fileIndex: number
): LayoutPoint {
  const base = baseGroupDimensions(group);
  const columns = fileGridColumns(group.group.files.length);
  let panelBottom = GROUP_HEADER_HEIGHT + GROUP_PADDING;
  for (let index = 0; index <= fileIndex; index += 1) {
    const file = group.group.files[index];
    if (file === undefined || !expandedFunctionFiles.has(file.id)) {
      continue;
    }
    const parentPosition = group.filePositions.get(file.id);
    const naturalY = parentPosition === undefined
      ? panelBottom
      : parentPosition.y + (FILE_HEIGHT - FUNCTION_HEIGHT) / 2;
    const y = Math.max(naturalY, panelBottom);
    if (index === fileIndex) {
      const nextFileSharesRow =
        index % columns < columns - 1
        && group.group.files[index + 1] !== undefined;
      return {
        x: nextFileSharesRow || parentPosition === undefined
          ? base.width + FUNCTION_PANEL_GAP
          : parentPosition.x + FILE_WIDTH + FUNCTION_PANEL_GAP,
        y
      };
    }
    const functionCount = graph?.functionCounts[file.id] ?? 0;
    panelBottom = y
      + Math.max(1, functionCount) * FUNCTION_HEIGHT
      + Math.max(0, functionCount - 1) * FUNCTION_GAP
      + FUNCTION_PANEL_GAP;
  }
  return {
    x: base.width + FUNCTION_PANEL_GAP,
    y: panelBottom
  };
}

function createFileCard(
  group: GroupView,
  file: GraphNode,
  position: LayoutPoint
): HTMLDivElement {
  const card = document.createElement('div');
  card.className = 'file-card';
  card.dataset.nodeId = file.id;
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `${file.name}, ${file.lang}, ${file.path}`);
  card.innerHTML =
    `<div class="file-title"><button class="file-function-toggle" type="button">▸</button>`
    + `<span class="file-name"></span>`
    + `<span class="language-badge"></span></div>`
    + `<div class="file-annotation"></div>`
    + `<span class="node-state-lamp" aria-hidden="true"></span>`
    + `<div class="agent-badges" aria-label="Editing agents"></div>`;
  const functionToggle = requireDescendant<HTMLButtonElement>(
    card,
    '.file-function-toggle'
  );
  const functionCount = graph?.functionCounts[file.id] ?? 0;
  functionToggle.disabled = functionCount === 0;
  functionToggle.setAttribute('aria-label', `Expand functions in ${file.name}`);
  updateFileFunctionToggle(functionToggle, file.id);
  for (const eventName of ['pointerdown', 'dblclick'] as const) {
    functionToggle.addEventListener(eventName, (event) => event.stopPropagation());
  }
  functionToggle.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleFileFunctions(group, file.id);
  });
  requireDescendant<HTMLElement>(card, '.file-name').textContent = file.name;
  requireDescendant<HTMLElement>(card, '.language-badge').textContent = file.lang;
  updateFileCardContent(card, file);
  applyNodePresentation(card, file);
  positionFileCard(card, position);

  let moved = false;
  let drag:
    | { pointerId: number; startX: number; startY: number; originalX: number; originalY: number }
    | undefined;
  card.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) {
      return;
    }
    event.stopPropagation();
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originalX: position.x,
      originalY: position.y
    };
    moved = false;
    card.setPointerCapture(event.pointerId);
  });
  card.addEventListener('pointermove', (event) => {
    showFileTooltip(event, file);
    if (drag?.pointerId !== event.pointerId) {
      return;
    }
    const dx = (event.clientX - drag.startX) / camera.scale;
    const dy = (event.clientY - drag.startY) / camera.scale;
    if (Math.hypot(dx, dy) > 3) {
      moved = true;
      card.classList.add('dragging');
      tooltip.hidden = true;
    }
    const fileBounds = baseGroupDimensions(group);
    position.x = clamp(
      drag.originalX + dx,
      GROUP_PADDING,
      fileBounds.width - FILE_WIDTH - GROUP_PADDING
    );
    position.y = clamp(
      drag.originalY + dy,
      GROUP_HEADER_HEIGHT + GROUP_PADDING,
      fileBounds.height - FILE_HEIGHT - GROUP_PADDING
    );
    positionFileCard(card, position);
    scheduleEdges();
  });
  const finishDrag = (event: PointerEvent): void => {
    if (drag?.pointerId !== event.pointerId) {
      return;
    }
    card.releasePointerCapture(event.pointerId);
    drag = undefined;
    card.classList.remove('dragging');
    if (moved) {
      persistLayout();
    }
  };
  card.addEventListener('pointerup', finishDrag);
  card.addEventListener('pointercancel', finishDrag);
  card.addEventListener('pointerenter', (event) => showFileTooltip(event, file));
  card.addEventListener('pointerleave', () => {
    tooltip.hidden = true;
  });
  card.addEventListener('click', () => {
    if (moved) {
      moved = false;
      return;
    }
    selectNode(file.id);
  });
  card.addEventListener('dblclick', () => {
    vscode.postMessage({ type: 'openFile', nodeId: file.id });
  });
  card.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      vscode.postMessage({ type: 'openFile', nodeId: file.id });
    } else if (event.key === ' ') {
      event.preventDefault();
      selectNode(file.id);
    }
  });
  return card;
}

function toggleFileFunctions(group: GroupView, fileId: string): void {
  if ((graph?.functionCounts[fileId] ?? 0) === 0) {
    return;
  }
  if (expandedFunctionFiles.has(fileId)) {
    expandedFunctionFiles.delete(fileId);
    for (const view of functionViews.values()) {
      if (view.node.path === fileId) {
        view.element.classList.add('closing');
      }
    }
    updateGroupGeometry(group);
    updateFileFunctionToggleForCard(fileId);
    drawEdges();
    window.setTimeout(
      () => {
        if (!expandedFunctionFiles.has(fileId)) {
          clearFileFunctionViews(fileId);
        }
      },
      reducedMotion() ? 0 : 180
    );
    return;
  }

  expandedFunctionFiles.add(fileId);
  updateGroupGeometry(group);
  updateFileFunctionToggleForCard(fileId);
  if (!loadedFunctionFiles.has(fileId)) {
    if (loadingFunctionFiles.has(fileId)) {
      return;
    }
    loadingFunctionFiles.add(fileId);
    updateFileFunctionToggleForCard(fileId);
    vscode.postMessage({ type: 'loadFunctions', fileId });
    return;
  }
  if (group.expanded) {
    renderFileFunctions(group, fileId);
  }
  drawEdges();
}

function applyFunctionPayload(payload: FunctionGraphPayload): void {
  if (!fileById.has(payload.fileId)) {
    layoutWarning.textContent =
      `Function data arrived for an unknown file: ${payload.fileId}`;
    layoutWarning.hidden = false;
    return;
  }
  for (const node of payload.nodes) {
    const pending = pendingNodeStates.get(node.id);
    const current = functionById.get(node.id);
    functionById.set(
      node.id,
      pending
        ? mergeNodeState(node, pending)
        : current
          ? mergeNodeState(node, current)
          : node
    );
    pendingNodeStates.delete(node.id);
  }
  for (const edge of payload.edges) {
    functionEdges.set(graphEdgeKey(edge), edge);
  }
  loadedFunctionFiles.add(payload.fileId);
  loadingFunctionFiles.delete(payload.fileId);
  updateFileFunctionToggleForCard(payload.fileId);
  const groupId = folderByFileId.get(payload.fileId);
  const group = groupId === undefined ? undefined : groupById.get(groupId);
  if (
    group !== undefined
    && group.expanded
    && expandedFunctionFiles.has(payload.fileId)
  ) {
    updateGroupGeometry(group);
    renderFileFunctions(group, payload.fileId);
  }
  drawEdges();
}

function updateFileFunctionToggleForCard(fileId: string): void {
  const card = nodeLayer.querySelector<HTMLElement>(
    `.file-card[data-node-id="${escapeSelector(fileId)}"]`
  );
  if (card === null) {
    return;
  }
  updateFileFunctionToggle(
    requireDescendant<HTMLButtonElement>(card, '.file-function-toggle'),
    fileId
  );
}

function updateFileFunctionToggle(
  toggle: HTMLButtonElement,
  fileId: string
): void {
  const expanded = expandedFunctionFiles.has(fileId);
  const loading = loadingFunctionFiles.has(fileId);
  toggle.classList.toggle('expanded', expanded);
  toggle.classList.toggle('loading', loading);
  toggle.setAttribute('aria-expanded', String(expanded));
  toggle.title = loading
    ? 'Loading functions…'
    : `${expanded ? 'Collapse' : 'Expand'} functions`;
}

function renderFileFunctions(group: GroupView, fileId: string): void {
  clearFileFunctionViews(fileId);
  const fileIndex = group.group.files.findIndex((file) => file.id === fileId);
  if (fileIndex < 0) {
    return;
  }
  const nodes = [...functionById.values()]
    .filter((node) => node.path === fileId)
    .sort((left, right) =>
      left.range.startLine - right.range.startLine || left.name.localeCompare(right.name)
    );
  const panel = functionPanelPosition(group, fileIndex);
  for (const [index, node] of nodes.entries()) {
    const position = {
      x: panel.x,
      y: panel.y + index * (FUNCTION_HEIGHT + FUNCTION_GAP)
    };
    const element = createFunctionCard(node, position, index);
    group.filesElement.append(element);
    functionViews.set(node.id, {
      node,
      groupId: group.group.id,
      position,
      element
    });
    requestAnimationFrame(() => element.classList.add('visible'));
  }
}

function createFunctionCard(
  node: GraphNode,
  position: LayoutPoint,
  childIndex: number
): HTMLDivElement {
  const card = document.createElement('div');
  card.className = 'function-card';
  card.classList.toggle('function-child-continuation', childIndex > 0);
  card.dataset.nodeId = node.id;
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute(
    'aria-label',
    `${node.name}, lines ${node.range.startLine + 1} to ${node.range.endLine + 1}`
  );
  card.style.left = `${position.x}px`;
  card.style.top = `${position.y}px`;
  card.innerHTML =
    `<div class="function-title"><span class="function-owner"></span>`
    + `<span class="function-name"></span></div><div class="function-range"></div>`
    + `<span class="node-state-lamp" aria-hidden="true"></span>`
    + `<div class="agent-badges" aria-label="Editing agents"></div>`;
  requireDescendant<HTMLElement>(card, '.function-owner').textContent =
    `${fileById.get(node.path)?.name ?? node.path} ›`;
  requireDescendant<HTMLElement>(card, '.function-name').textContent = node.name;
  requireDescendant<HTMLElement>(card, '.function-range').textContent =
    `lines ${node.range.startLine + 1}–${node.range.endLine + 1}`;
  applyNodePresentation(card, node);
  card.addEventListener('click', (event) => {
    event.stopPropagation();
    selectNode(node.id);
  });
  card.addEventListener('dblclick', (event) => {
    event.stopPropagation();
    vscode.postMessage({ type: 'openFile', nodeId: node.id });
  });
  card.addEventListener('pointerenter', (event) => showFunctionTooltip(event, node));
  card.addEventListener('pointermove', (event) => showFunctionTooltip(event, node));
  card.addEventListener('pointerleave', () => {
    tooltip.hidden = true;
  });
  card.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      vscode.postMessage({ type: 'openFile', nodeId: node.id });
    } else if (event.key === ' ') {
      event.preventDefault();
      selectNode(node.id);
    }
  });
  return card;
}

function showFunctionTooltip(event: PointerEvent, node: GraphNode): void {
  tooltip.textContent =
    `${node.path}#${node.name}\nlines ${node.range.startLine + 1}–${node.range.endLine + 1}`;
  tooltip.hidden = false;
  const maxLeft = window.innerWidth - tooltip.offsetWidth - 12;
  const maxTop = window.innerHeight - tooltip.offsetHeight - 12;
  tooltip.style.left = `${Math.max(8, Math.min(maxLeft, event.clientX + 14))}px`;
  tooltip.style.top = `${Math.max(8, Math.min(maxTop, event.clientY + 14))}px`;
}

function clearFileFunctionViews(fileId: string): void {
  for (const [nodeId, view] of functionViews) {
    if (view.node.path === fileId) {
      view.element.remove();
      functionViews.delete(nodeId);
    }
  }
}

function clearGroupFunctionViews(groupId: string): void {
  for (const [nodeId, view] of functionViews) {
    if (view.groupId === groupId) {
      view.element.remove();
      functionViews.delete(nodeId);
    }
  }
}

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function graphEdgeKey(edge: GraphEdge): string {
  return `${edge.kind}\0${edge.from}\0${edge.to}`;
}

function positionFileCard(card: HTMLElement, position: LayoutPoint): void {
  card.style.transform = `translate(${position.x}px, ${position.y}px)`;
}

function updateFileCardContent(card: HTMLElement, file: GraphNode): void {
  const annotation = effectiveAnnotation(file);
  requireDescendant<HTMLElement>(card, '.file-annotation').textContent =
    annotation === null ? '' : truncateAnnotation(annotation);
}

function applyStateUpdate(update: NodeStateUpdate): void {
  agentsById = new Map(update.agents.map((agent) => [agent.id, agent]));
  if (update.diagnostics !== undefined) {
    diagnosticsByNode = new Map(
      Object.entries(update.diagnostics).map(([nodeId, diagnostics]) => [
        nodeId,
        diagnostics.map(cloneDiagnostic)
      ])
    );
  }
  if (update.agentReports !== undefined) {
    agentReportsByNode = new Map(
      Object.entries(update.agentReports).map(([nodeId, reports]) => [
        nodeId,
        reports.map((report) => ({ ...report }))
      ])
    );
  }
  if (update.settings !== undefined) {
    applyWebviewSettings(update.settings);
  }
  if (update.summary !== undefined) {
    renderStatusSummary(update.summary);
  }
  // Refreshed before the node loop below, because applyNodePresentation folds
  // the coverage gap into each card's aria-label.
  if (update.testRun !== undefined) {
    uncoveredNodeIds = new Set(update.testRun.uncovered);
  }
  for (const incoming of update.nodes) {
    const current = fileById.get(incoming.id) ?? functionById.get(incoming.id);
    if (current) {
      mergeNodeState(current, incoming);
      pendingNodeStates.delete(incoming.id);
    } else {
      pendingNodeStates.set(incoming.id, incoming);
    }
  }

  for (const incoming of update.nodes) {
    const node = fileById.get(incoming.id)
      ?? functionById.get(incoming.id)
      ?? pendingNodeStates.get(incoming.id);
    if (!node) {
      continue;
    }
    const card = nodeLayer.querySelector<HTMLElement>(
      `.file-card[data-node-id="${escapeSelector(node.id)}"], `
      + `.function-card[data-node-id="${escapeSelector(node.id)}"]`
    );
    if (card) {
      applyNodePresentation(card, node);
    }
    if (requiresAttention(node.state)) {
      revealAttentionNode(node);
    }
  }
  if (update.testRun !== undefined) {
    applyTestRun(update.testRun);
  }
  renderAgentHierarchy();
  if (selectedNodeId) {
    const selected = fileById.get(selectedNodeId) ?? functionById.get(selectedNodeId);
    if (selected) {
      updateSelectedStateDetails(selected);
    }
  }
}

function mergeNodeState(target: GraphNode, state: GraphNode): GraphNode {
  target.state = state.state;
  target.errorSources = [...state.errorSources];
  target.editingAgents = [...state.editingAgents];
  target.lastVerifiedAt = state.lastVerifiedAt;
  return target;
}

function requiresAttention(state: NodeState): boolean {
  return state === 'editing'
    || state === 'dirty'
    || state === 'verifying'
    || state === 'error';
}

function revealAttentionNode(node: GraphNode): void {
  const fileId = node.kind === 'file' ? node.id : node.path;
  const group = groupForFile(fileId);
  if (!group) {
    return;
  }
  // Expanding changes only this group's dimensions and children. Its x/y and
  // every other group remain untouched; no force simulation is restarted.
  setGroupExpanded(group, true, false);
  if (node.kind !== 'function' || expandedFunctionFiles.has(fileId)) {
    return;
  }
  expandedFunctionFiles.add(fileId);
  updateGroupGeometry(group);
  updateFileFunctionToggleForCard(fileId);
  if (!loadedFunctionFiles.has(fileId)) {
    if (!loadingFunctionFiles.has(fileId)) {
      loadingFunctionFiles.add(fileId);
      updateFileFunctionToggleForCard(fileId);
      vscode.postMessage({ type: 'loadFunctions', fileId });
    }
  } else {
    renderFileFunctions(group, fileId);
  }
  drawEdges();
}

function applyNodePresentation(card: HTMLElement, node: GraphNode): void {
  const states: NodeState[] = [
    'idle',
    'editing',
    'dirty',
    'verifying',
    'passing',
    'error'
  ];
  for (const stateName of states) {
    card.classList.toggle(`node-state-${stateName}`, node.state === stateName);
  }
  card.classList.toggle('node-conflict', hasAgentConflict(node));
  card.classList.toggle('coverage-gap', uncoveredNodeIds.has(node.id));
  card.dataset.state = node.state;
  const lamp = card.querySelector<HTMLElement>('.node-state-lamp');
  if (lamp) {
    lamp.title = `State: ${node.state}`;
  }
  // The lamp is aria-hidden decoration, so the state has to reach assistive
  // technology through the card label itself, not colour or shape alone.
  const baseLabel = card.dataset.baseLabel ?? card.getAttribute('aria-label') ?? node.name;
  card.dataset.baseLabel = baseLabel;
  const errorDetail = node.errorSources.length > 0
    ? ` via ${node.errorSources.join(', ')}`
    : '';
  const coverageDetail = uncoveredNodeIds.has(node.id) ? ', not covered by tests' : '';
  card.setAttribute(
    'aria-label',
    `${baseLabel}, state ${node.state}${errorDetail}${coverageDetail}`
  );
  const badges = card.querySelector<HTMLElement>('.agent-badges');
  if (!badges) {
    return;
  }
  badges.replaceChildren(
    ...node.editingAgents.map((agentId) =>
      createAgentBadge(agentsById.get(agentId) ?? fallbackAgent(agentId))
    )
  );
  badges.hidden = node.editingAgents.length === 0;
  badges.setAttribute(
    'aria-label',
    node.editingAgents.length > 0
      ? `Editing agents: ${node.editingAgents.join(', ')}`
      : 'No editing agent'
  );
}

function createAgentBadge(agent: AgentSnapshot): HTMLSpanElement {
  const badge = document.createElement('span');
  const [shape = 'square', tone = 'violet'] = agent.badge.split('-');
  badge.className = `agent-badge shape-${shape} tone-${tone}`;
  badge.textContent = agent.name.slice(0, 1).toUpperCase();
  badge.title = `${agent.name} (${agent.id})`;
  badge.setAttribute('aria-label', badge.title);
  return badge;
}

function fallbackAgent(agentId: string): AgentSnapshot {
  return {
    id: agentId,
    name: agentId,
    parentId: null,
    badge: 'square-violet',
    status: 'active',
    workAreas: []
  };
}

function renderAgentHierarchy(): void {
  agentTree.replaceChildren();
  agentEmpty.hidden = agentsById.size > 0;
  const agents = [...agentsById.values()];
  const children = new Map<string | null, AgentSnapshot[]>();
  for (const agent of agents) {
    const parent = agent.parentId && agentsById.has(agent.parentId)
      ? agent.parentId
      : null;
    const siblings = children.get(parent) ?? [];
    siblings.push(agent);
    children.set(parent, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort((left, right) => left.name.localeCompare(right.name));
  }

  const rendered = new Set<string>();
  const createBranch = (agent: AgentSnapshot, ancestors: Set<string>): HTMLLIElement => {
    const item = document.createElement('li');
    item.className = 'agent-entry';
    const line = document.createElement('div');
    line.className = 'agent-line';
    line.append(createAgentBadge(agent));
    const name = document.createElement('span');
    name.className = 'agent-name';
    name.textContent = agent.name;
    line.append(name);
    const state = document.createElement('span');
    state.className = 'agent-status';
    state.textContent = agent.status;
    line.append(state);
    item.append(line);
    if (agent.workAreas.length > 0) {
      const work = document.createElement('p');
      work.className = 'agent-work';
      work.textContent = agent.workAreas.join(', ');
      item.append(work);
    }
    rendered.add(agent.id);
    if (!ancestors.has(agent.id)) {
      const descendants = children.get(agent.id) ?? [];
      if (descendants.length > 0) {
        const list = document.createElement('ul');
        const nextAncestors = new Set(ancestors).add(agent.id);
        for (const child of descendants) {
          list.append(createBranch(child, nextAncestors));
        }
        item.append(list);
      }
    }
    return item;
  };

  for (const root of children.get(null) ?? []) {
    agentTree.append(createBranch(root, new Set()));
  }
  for (const agent of agents) {
    if (!rendered.has(agent.id)) {
      agentTree.append(createBranch(agent, new Set()));
    }
  }

  const conflicts = allKnownNodes()
    .filter(hasAgentConflict)
    .map((node) => `${node.id} (${node.editingAgents.join(', ')})`);
  agentConflicts.hidden = conflicts.length === 0;
  agentConflicts.textContent = conflicts.length === 0
    ? ''
    : `Potential conflicts: ${conflicts.join('; ')}`;
}

function allKnownNodes(): GraphNode[] {
  const nodes = new Map<string, GraphNode>();
  for (const node of [
    ...fileById.values(),
    ...functionById.values(),
    ...pendingNodeStates.values()
  ]) {
    nodes.set(node.id, node);
  }
  return [...nodes.values()];
}

function showFileTooltip(event: PointerEvent, file: GraphNode): void {
  const annotation = effectiveAnnotation(file);
  tooltip.textContent = annotation === null ? file.path : `${file.path}\n\n${annotation}`;
  tooltip.hidden = false;
  const maxLeft = window.innerWidth - tooltip.offsetWidth - 12;
  const maxTop = window.innerHeight - tooltip.offsetHeight - 12;
  tooltip.style.left = `${Math.max(8, Math.min(maxLeft, event.clientX + 14))}px`;
  tooltip.style.top = `${Math.max(8, Math.min(maxTop, event.clientY + 14))}px`;
}

function selectNode(nodeId: string): void {
  selectedNodeId = nodeId;
  for (const card of Array.from(
    nodeLayer.querySelectorAll<HTMLElement>('.file-card, .function-card')
  )) {
    card.classList.toggle('selected', card.dataset.nodeId === nodeId);
  }
  const node = fileById.get(nodeId) ?? functionById.get(nodeId);
  if (node === undefined) {
    return;
  }
  const isFile = node.kind === 'file';
  sidebarEmpty.hidden = true;
  nodeDetails.hidden = false;
  nodeName.textContent = node.name;
  nodePath.textContent = node.path;
  nodeLanguage.textContent = node.lang;
  updateSelectedStateDetails(node);
  autoAnnotation.textContent = isFile
    ? (node.annotation.auto ?? 'No automatic annotation.')
    : `Source lines ${node.range.startLine + 1}–${node.range.endLine + 1}`;
  manualAnnotation.value = isFile ? (node.annotation.manual ?? '') : '';
  manualAnnotation.disabled = !isFile;
  const savePending = annotationSaves.isPending(nodeId);
  saveAnnotationButton.disabled = !isFile || savePending;
  saveStatus.textContent = !isFile
    ? 'Function annotations are read-only in Phase 1.'
    : savePending
    ? (
      annotationSaves.hasNewerPendingDraft(nodeId)
        ? 'Saving previous version; newer changes are still unsaved.'
        : 'Saving…'
    )
    : (annotationSaves.hasDraft(nodeId) ? 'Unsaved changes' : '');
  saveStatus.classList.remove('error');
}

function updateSelectedStateDetails(node: GraphNode): void {
  nodeState.textContent = node.state;
  nodeAgents.textContent = node.editingAgents.length > 0
    ? node.editingAgents
      .map((id) => agentsById.get(id)?.name ?? id)
      .join(', ')
    : (node.state === 'editing' ? 'human / unknown' : 'none');
  nodeErrors.textContent = node.errorSources.length > 0
    ? node.errorSources.join(', ')
    : 'none';
  renderErrorSourceList(node.errorSources);
  renderSelectedDiagnostics(node.id);
  renderSelectedTestFailures(node.id);
  renderSelectedAgentReports(node.id);
  nodeConflict.hidden = !hasAgentConflict(node);
}

function renderErrorSourceList(
  sources: readonly GraphNode['errorSources'][number][]
): void {
  const labels: Record<GraphNode['errorSources'][number], {
    icon: string;
    label: string;
  }> = {
    test: { icon: 'T', label: 'Test failure' },
    diagnostic: { icon: 'D', label: 'Static diagnostic' },
    runtime: { icon: 'R', label: 'Runtime exception' },
    agent: { icon: 'A', label: 'Agent report' }
  };
  errorSourceField.hidden = sources.length === 0;
  nodeErrorSourceList.replaceChildren(...sources.map((source) => {
    const item = document.createElement('li');
    item.className = `error-source-chip error-source-${source}`;
    const icon = document.createElement('span');
    icon.className = 'error-source-icon';
    const iconText = document.createElement('span');
    iconText.textContent = labels[source].icon;
    icon.append(iconText);
    const label = document.createElement('span');
    label.textContent = `${source} — ${labels[source].label}`;
    item.append(icon, label);
    return item;
  }));
}

function renderSelectedDiagnostics(nodeId: string): void {
  const diagnostics = diagnosticsByNode.get(nodeId) ?? [];
  diagnosticField.hidden = diagnostics.length === 0;
  nodeDiagnostics.replaceChildren(...diagnostics.map((diagnostic) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `diagnostic-entry diagnostic-${diagnostic.severity}`;
    button.innerHTML =
      `<span class="diagnostic-heading"></span>`
      + `<span class="diagnostic-message"></span>`
      + `<span class="diagnostic-location"></span>`;
    requireDescendant<HTMLElement>(button, '.diagnostic-heading').textContent =
      `${diagnostic.source} · ${diagnostic.severity}`;
    requireDescendant<HTMLElement>(button, '.diagnostic-message').textContent =
      diagnostic.message;
    requireDescendant<HTMLElement>(button, '.diagnostic-location').textContent =
      `line ${diagnostic.range.startLine + 1}, column `
      + `${diagnostic.range.startCharacter + 1}`;
    button.addEventListener('click', () => {
      vscode.postMessage({
        type: 'openDiagnostic',
        fileId: diagnostic.fileId,
        line: diagnostic.range.startLine,
        character: diagnostic.range.startCharacter
      });
    });
    item.append(button);
    return item;
  }));
}

function renderSelectedTestFailures(nodeId: string): void {
  const failures = testRunSnapshot.failures[nodeId] ?? [];
  testFailureField.hidden = failures.length === 0;
  nodeTestFailures.replaceChildren(...failures.map((failure) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'test-failure-entry';
    button.innerHTML =
      `<span class="test-failure-name"></span>`
      + `<span class="test-failure-message"></span>`
      + `<pre class="test-failure-stack"></pre>`;
    requireDescendant<HTMLElement>(button, '.test-failure-name').textContent =
      `${failure.source}: ${failure.testName}`;
    requireDescendant<HTMLElement>(button, '.test-failure-message').textContent =
      failure.message;
    requireDescendant<HTMLElement>(button, '.test-failure-stack').textContent =
      failure.stack;
    button.addEventListener('click', () => {
      vscode.postMessage({
        type: 'openTestFailure',
        fileId: failure.fileId,
        line: failure.line,
        character: failure.character
      });
    });
    item.append(button);
    return item;
  }));
}

function renderSelectedAgentReports(nodeId: string): void {
  const reports = agentReportsByNode.get(nodeId) ?? [];
  agentReportField.hidden = reports.length === 0;
  nodeAgentReports.replaceChildren(...reports.map((report) => {
    const item = document.createElement('li');
    item.className = 'agent-report-entry';
    const heading = document.createElement('span');
    heading.className = 'agent-report-heading';
    heading.textContent = `${report.agentName} (${report.agentId})`;
    const message = document.createElement('span');
    message.className = 'agent-report-message';
    message.textContent = report.message;
    item.append(heading, message);
    return item;
  }));
}

function renderStatusSummary(summary: StatusSummary): void {
  stateSummary.textContent = `${summary.activeAgents} agents active · `
    + `${summary.editingNodes} editing · `
    + `${summary.errorNodes} errors · `
    + `${summary.passingNodes} passing`;
}

function applyWebviewSettings(settings: WebviewSettings): void {
  document.body.classList.toggle(
    'flash-disabled',
    !settings.flashAnimations
  );
}

function applyTestRun(snapshot: TestRunSnapshot): void {
  testRunSnapshot = cloneTestRun(snapshot);
  runTestsButton.disabled =
    snapshot.phase === 'running' || snapshot.phase === 'flow';
  if (snapshot.message) {
    status.textContent = snapshot.message;
  }
  for (const group of groups) {
    group.element.classList.remove('test-run-passing');
  }
  applyCoverageGaps();
  if (snapshot.phase === 'complete' && snapshot.outcome === 'passed') {
    const touchedGroups = new Set(
      snapshot.sequence
        .map((nodeId) => fileById.get(nodeId)?.id ?? functionById.get(nodeId)?.path)
        .map((fileId) => fileId ? folderByFileId.get(fileId) : undefined)
        .filter((groupId): groupId is string => groupId !== undefined)
    );
    for (const groupId of touchedGroups) {
      const group = groupById.get(groupId);
      if (!group) {
        continue;
      }
      group.element.classList.add('test-run-passing');
      setGroupExpanded(group, false, false);
    }
  }
  drawEdges();
  if (selectedNodeId) {
    renderSelectedTestFailures(selectedNodeId);
  }
}

// Coverage gaps are an overlay, not a NodeState: a node can be idle, dirty or
// error and still be a test blind spot, so this must not touch the state
// precedence that NodeStateStore owns.
function applyCoverageGaps(): void {
  uncoveredNodeIds = new Set(testRunSnapshot.uncovered);
  for (const card of Array.from(nodeLayer.querySelectorAll<HTMLElement>(
    '.file-card, .function-card'
  ))) {
    const nodeId = card.dataset.nodeId;
    card.classList.toggle(
      'coverage-gap',
      nodeId !== undefined && uncoveredNodeIds.has(nodeId)
    );
  }
}

function applyFlowPresentation(): void {
  for (const card of Array.from(nodeLayer.querySelectorAll<HTMLElement>(
    '.file-card, .function-card'
  ))) {
    card.classList.remove('test-flow-active');
    card.style.removeProperty('--test-flow-order');
  }
  for (const edge of Array.from(
    edgeLayer.querySelectorAll<SVGPathElement>('.dependency')
  )) {
    edge.classList.remove('test-flow-edge');
    edge.style.removeProperty('--test-flow-order');
  }
  if (testRunSnapshot.phase !== 'flow') {
    return;
  }
  for (const [index, nodeId] of testRunSnapshot.sequence.entries()) {
    const card = Array.from(nodeLayer.querySelectorAll<HTMLElement>(
      '.file-card, .function-card'
    )).find((candidate) => candidate.dataset.nodeId === nodeId);
    if (card) {
      card.classList.add('test-flow-active');
      card.style.setProperty('--test-flow-order', String(index));
    }
    const nextId = testRunSnapshot.sequence[index + 1];
    if (!nextId) {
      continue;
    }
    const edge = Array.from(
      edgeLayer.querySelectorAll<SVGPathElement>('.dependency')
    ).find((candidate) =>
      candidate.dataset.from === nodeId && candidate.dataset.to === nextId
    );
    if (edge) {
      edge.classList.add('test-flow-edge');
      edge.style.setProperty('--test-flow-order', String(index));
    }
  }
}

function previewManualAnnotation(): void {
  if (selectedNodeId === undefined) {
    return;
  }
  const file = fileById.get(selectedNodeId);
  if (file === undefined) {
    return;
  }
  file.annotation.manual =
    manualAnnotation.value.trim().length === 0 ? null : manualAnnotation.value;
  annotationSaves.setDraft(selectedNodeId, manualAnnotation.value);
  const card = nodeLayer.querySelector<HTMLElement>(
    `.file-card[data-node-id="${escapeSelector(selectedNodeId)}"]`
  );
  if (card !== null) {
    updateFileCardContent(card, file);
  }
  saveStatus.textContent = 'Unsaved changes';
  saveStatus.classList.remove('error');
}

function saveSelectedAnnotation(): void {
  if (selectedNodeId === undefined || !fileById.has(selectedNodeId)) {
    return;
  }
  if (!annotationSaves.begin(selectedNodeId, manualAnnotation.value)) {
    saveAnnotationButton.disabled = true;
    saveStatus.textContent = 'A save is already in progress for this file.';
    return;
  }
  saveAnnotationButton.disabled = true;
  saveStatus.textContent = 'Saving…';
  saveStatus.classList.remove('error');
  vscode.postMessage({
    type: 'saveAnnotation',
    nodeId: selectedNodeId,
    manual: manualAnnotation.value
  });
}

function openSelectedFile(): void {
  if (selectedNodeId !== undefined) {
    vscode.postMessage({ type: 'openFile', nodeId: selectedNodeId });
  }
}

function applySavedAnnotation(nodeId: string, manual: string | null): void {
  const file = fileById.get(nodeId);
  if (file === undefined) {
    return;
  }
  const { hasNewerDraft } = annotationSaves.finish(nodeId, manual);
  if (!hasNewerDraft) {
    file.annotation.manual = manual;
    const card = nodeLayer.querySelector<HTMLElement>(
      `.file-card[data-node-id="${escapeSelector(nodeId)}"]`
    );
    if (card !== null) {
      updateFileCardContent(card, file);
    }
  }
  if (selectedNodeId === nodeId) {
    if (!hasNewerDraft) {
      manualAnnotation.value = manual ?? '';
    }
    saveAnnotationButton.disabled = false;
    saveStatus.textContent = hasNewerDraft
      ? 'Saved previous version; newer changes are still unsaved.'
      : 'Saved';
    saveStatus.classList.remove('error');
  }
}

function drawEdges(): void {
  if (graph === undefined) {
    return;
  }
  clearEdgeGraphics();
  const edges = visibleEdges([
    ...graph.edges,
    ...functionEdges.values()
  ]);
  const edgeKeys = new Set(edges.map((edge) => edgeKey(edge.from, edge.to)));
  for (const visibleEdge of edges) {
    const source = endpointBounds(visibleEdge.from);
    const target = endpointBounds(visibleEdge.to);
    if (source === undefined || target === undefined) {
      continue;
    }
    const hasReverseEdge = edgeKeys.has(edgeKey(visibleEdge.to, visibleEdge.from));
    const geometry = edgeGeometry(
      source,
      target,
      hasReverseEdge ? RECIPROCAL_EDGE_OFFSET_PX / camera.scale : 0
    );
    if (geometry === undefined) {
      continue;
    }
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute(
      'd',
      `M ${geometry.start.x} ${geometry.start.y} `
      + `C ${geometry.sourceControl.x} ${geometry.sourceControl.y}, `
      + `${geometry.targetControl.x} ${geometry.targetControl.y}, `
      + `${geometry.end.x} ${geometry.end.y}`
    );
    path.setAttribute(
      'class',
      [
        'dependency',
        visibleEdge.kind,
        visibleEdge.kind === 'import' ? '' : 'phase1-edge',
        visibleEdge.count > 1 ? 'aggregate' : ''
      ].filter(Boolean).join(' ')
    );
    path.setAttribute('marker-end', 'url(#dependency-arrow)');
    path.dataset.from = visibleEdge.from;
    path.dataset.to = visibleEdge.to;
    path.setAttribute(
      'stroke-width',
      String(Math.min(8, 1.4 + Math.log2(visibleEdge.count) * 1.8))
    );
    edgeLayer.append(path);

    if (visibleEdge.count > 1) {
      const midpoint = cubicPoint(geometry, 0.5);
      const tangent = cubicTangent(geometry, 0.5);
      const tangentLength = Math.hypot(tangent.x, tangent.y) || 1;
      const labelOffset = EDGE_LABEL_OFFSET_PX / camera.scale;
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute(
        'x',
        String(midpoint.x - tangent.y / tangentLength * labelOffset)
      );
      label.setAttribute(
        'y',
        String(midpoint.y + tangent.x / tangentLength * labelOffset)
      );
      label.setAttribute('class', 'edge-count');
      label.textContent = String(visibleEdge.count);
      edgeLayer.append(label);
    }
  }
  applyFlowPresentation();
}

function visibleEdges(edges: readonly GraphEdge[]): VisibleEdge[] {
  const counts = new Map<string, VisibleEdge>();
  for (const edge of edges) {
    let source: string | undefined;
    let target: string | undefined;
    if (edge.kind === 'import') {
      const sourceGroupId = folderByFileId.get(edge.from);
      const targetGroupId = folderByFileId.get(edge.to);
      const sourceGroup = sourceGroupId === undefined
        ? undefined
        : groupById.get(sourceGroupId);
      const targetGroup = targetGroupId === undefined
        ? undefined
        : groupById.get(targetGroupId);
      if (
        sourceGroupId === undefined
        || targetGroupId === undefined
        || sourceGroup === undefined
        || targetGroup === undefined
        || (sourceGroupId === targetGroupId && !sourceGroup.expanded)
      ) {
        continue;
      }
      source = sourceGroup.expanded ? edge.from : sourceGroupId;
      target = targetGroup.expanded ? edge.to : targetGroupId;
    } else if (edge.kind === 'contains') {
      if (
        !expandedFunctionFiles.has(edge.from)
        || !groupForFile(edge.from)?.expanded
        || !functionViews.has(edge.to)
      ) {
        continue;
      }
      source = edge.from;
      target = edge.to;
    } else {
      const sourceNode = functionById.get(edge.from);
      const targetNode = functionById.get(edge.to);
      if (
        sourceNode === undefined
        || targetNode === undefined
        || (
          !expandedFunctionFiles.has(sourceNode.path)
          && !expandedFunctionFiles.has(targetNode.path)
        )
      ) {
        continue;
      }
      source = functionEndpointId(sourceNode);
      target = functionEndpointId(targetNode);
    }
    if (source === undefined || target === undefined || source === target) {
      continue;
    }
    const key = `${edge.kind}\0${edgeKey(source, target)}`;
    const existing = counts.get(key);
    if (existing === undefined) {
      counts.set(key, {
        from: source,
        to: target,
        count: 1,
        kind: edge.kind
      });
    } else {
      existing.count += 1;
    }
  }
  return [...counts.values()];
}

function functionEndpointId(node: GraphNode): string | undefined {
  const group = groupForFile(node.path);
  if (group === undefined) {
    return undefined;
  }
  if (!group.expanded) {
    return group.group.id;
  }
  return expandedFunctionFiles.has(node.path) && functionViews.has(node.id)
    ? node.id
    : node.path;
}

function groupForFile(fileId: string): GroupView | undefined {
  const groupId = folderByFileId.get(fileId);
  return groupId === undefined ? undefined : groupById.get(groupId);
}

function endpointBounds(id: string): EndpointBounds | undefined {
  const group = groupById.get(id);
  if (group !== undefined) {
    return {
      x: group.x + group.width / 2,
      y: group.y + group.height / 2,
      halfWidth: group.width / 2,
      halfHeight: group.height / 2
    };
  }
  const functionView = functionViews.get(id);
  if (functionView !== undefined) {
    const parent = groupById.get(functionView.groupId);
    if (parent === undefined || !parent.expanded) {
      return undefined;
    }
    return {
      x: parent.x + functionView.position.x + FUNCTION_WIDTH / 2,
      y: parent.y + functionView.position.y + FUNCTION_HEIGHT / 2,
      halfWidth: FUNCTION_WIDTH / 2,
      halfHeight: FUNCTION_HEIGHT / 2
    };
  }
  const groupId = folderByFileId.get(id);
  const parent = groupId === undefined ? undefined : groupById.get(groupId);
  const relative = parent?.filePositions.get(id);
  if (parent === undefined || relative === undefined || !parent.expanded) {
    return undefined;
  }
  return {
    x: parent.x + relative.x + FILE_WIDTH / 2,
    y: parent.y + relative.y + FILE_HEIGHT / 2,
    halfWidth: FILE_WIDTH / 2,
    halfHeight: FILE_HEIGHT / 2
  };
}

function edgeGeometry(
  source: EndpointBounds,
  target: EndpointBounds,
  reciprocalOffset: number
): EdgeGeometry | undefined {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  if (dx === 0 && dy === 0) {
    return undefined;
  }
  const startHit = rectangleBoundaryPoint(source, dx, dy);
  const endHit = rectangleBoundaryPoint(target, -dx, -dy);
  const gap = Math.hypot(endHit.point.x - startHit.point.x, endHit.point.y - startHit.point.y);
  const handleLength = Math.min(110, Math.max(4, gap * 0.32));
  const curveOffset = Math.min(reciprocalOffset, handleLength * 0.65);
  const directionLength = Math.hypot(dx, dy);
  const normalX = -dy / directionLength;
  const normalY = dx / directionLength;
  const curveX = normalX * curveOffset;
  const curveY = normalY * curveOffset;
  const sourceControl = startHit.axis === 'x'
    ? { x: startHit.point.x + Math.sign(dx) * handleLength, y: startHit.point.y }
    : { x: startHit.point.x, y: startHit.point.y + Math.sign(dy) * handleLength };
  const targetControl = endHit.axis === 'x'
    ? { x: endHit.point.x - Math.sign(dx) * handleLength, y: endHit.point.y }
    : { x: endHit.point.x, y: endHit.point.y - Math.sign(dy) * handleLength };
  sourceControl.x += curveX;
  sourceControl.y += curveY;
  targetControl.x += curveX;
  targetControl.y += curveY;
  return {
    start: startHit.point,
    sourceControl,
    targetControl,
    end: endHit.point
  };
}

function rectangleBoundaryPoint(
  bounds: EndpointBounds,
  dx: number,
  dy: number
): { point: LayoutPoint; axis: 'x' | 'y' } {
  const xScale = dx === 0 ? Number.POSITIVE_INFINITY : bounds.halfWidth / Math.abs(dx);
  const yScale = dy === 0 ? Number.POSITIVE_INFINITY : bounds.halfHeight / Math.abs(dy);
  const axis = xScale <= yScale ? 'x' : 'y';
  const scale = Math.min(xScale, yScale);
  return {
    point: {
      x: bounds.x + dx * scale,
      y: bounds.y + dy * scale
    },
    axis
  };
}

function cubicPoint(geometry: EdgeGeometry, time: number): LayoutPoint {
  const inverse = 1 - time;
  return {
    x:
      inverse ** 3 * geometry.start.x
      + 3 * inverse ** 2 * time * geometry.sourceControl.x
      + 3 * inverse * time ** 2 * geometry.targetControl.x
      + time ** 3 * geometry.end.x,
    y:
      inverse ** 3 * geometry.start.y
      + 3 * inverse ** 2 * time * geometry.sourceControl.y
      + 3 * inverse * time ** 2 * geometry.targetControl.y
      + time ** 3 * geometry.end.y
  };
}

function cubicTangent(geometry: EdgeGeometry, time: number): LayoutPoint {
  const inverse = 1 - time;
  return {
    x:
      3 * inverse ** 2 * (geometry.sourceControl.x - geometry.start.x)
      + 6 * inverse * time * (geometry.targetControl.x - geometry.sourceControl.x)
      + 3 * time ** 2 * (geometry.end.x - geometry.targetControl.x),
    y:
      3 * inverse ** 2 * (geometry.sourceControl.y - geometry.start.y)
      + 6 * inverse * time * (geometry.targetControl.y - geometry.sourceControl.y)
      + 3 * time ** 2 * (geometry.end.y - geometry.targetControl.y)
  };
}

function edgeKey(from: string, to: string): string {
  return `${from}\0${to}`;
}

function clearEdgeGraphics(): void {
  for (const element of Array.from(
    edgeLayer.querySelectorAll('.dependency, .edge-count')
  )) {
    element.remove();
  }
}

function scheduleEdges(): void {
  if (edgeFrame !== undefined) {
    return;
  }
  edgeFrame = requestAnimationFrame(() => {
    edgeFrame = undefined;
    drawEdges();
  });
}

function persistLayout(): void {
  const layout: WorkspaceLayout = { version: 1, groups: {}, files: {} };
  for (const group of groups) {
    layout.groups[group.group.id] = {
      x: Math.round(group.x),
      y: Math.round(group.y),
      expanded: group.expanded
    };
    for (const [fileId, position] of group.filePositions) {
      layout.files[fileId] = {
        x: Math.round(position.x),
        y: Math.round(position.y)
      };
    }
  }
  vscode.postMessage({ type: 'saveLayout', layout });
}

function fitToContent(): void {
  if (groups.length === 0) {
    camera = { x: 0, y: 0, scale: 1 };
    applyCamera();
    return;
  }
  const bounds = groups.reduce(
    (value, group) => ({
      minX: Math.min(value.minX, group.x),
      minY: Math.min(value.minY, group.y),
      maxX: Math.max(value.maxX, group.x + group.width),
      maxY: Math.max(value.maxY, group.y + group.height)
    }),
    {
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY
    }
  );
  const rect = canvas.getBoundingClientRect();
  const padding = 56;
  const contentWidth = Math.max(1, bounds.maxX - bounds.minX);
  const contentHeight = Math.max(1, bounds.maxY - bounds.minY);
  const scale = clamp(
    Math.min(
      (rect.width - padding * 2) / contentWidth,
      (rect.height - padding * 2) / contentHeight
    ),
    MIN_SCALE,
    1.25
  );
  camera = {
    scale,
    x: (rect.width - contentWidth * scale) / 2 - bounds.minX * scale,
    y: (rect.height - contentHeight * scale) / 2 - bounds.minY * scale
  };
  applyCamera();
  scheduleEdges();
}

function onWheel(event: WheelEvent): void {
  event.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const pointerX = event.clientX - rect.left;
  const pointerY = event.clientY - rect.top;
  const worldX = (pointerX - camera.x) / camera.scale;
  const worldY = (pointerY - camera.y) / camera.scale;
  const nextScale = clamp(
    camera.scale * Math.exp(-event.deltaY * 0.0012),
    MIN_SCALE,
    MAX_SCALE
  );
  camera = {
    scale: nextScale,
    x: pointerX - worldX * nextScale,
    y: pointerY - worldY * nextScale
  };
  applyCamera();
  scheduleEdges();
}

function startPan(event: PointerEvent): void {
  if (
    event.button !== 0
    || (event.target as Element).closest('.folder-group, .file-card') !== null
  ) {
    return;
  }
  panState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    cameraX: camera.x,
    cameraY: camera.y
  };
  canvas.setPointerCapture(event.pointerId);
  canvas.classList.add('panning');
}

function movePan(event: PointerEvent): void {
  if (panState?.pointerId !== event.pointerId) {
    return;
  }
  camera.x = panState.cameraX + event.clientX - panState.startX;
  camera.y = panState.cameraY + event.clientY - panState.startY;
  applyCamera();
}

function endPan(event: PointerEvent): void {
  if (panState?.pointerId !== event.pointerId) {
    return;
  }
  canvas.releasePointerCapture(event.pointerId);
  panState = undefined;
  canvas.classList.remove('panning');
}

function applyCamera(): void {
  viewport.style.transform =
    `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`;
  const markerSize = ARROW_SIZE_PX / camera.scale;
  dependencyArrow.setAttribute('markerWidth', String(markerSize));
  dependencyArrow.setAttribute('markerHeight', String(markerSize));
}

function clearGraph(): void {
  nodeLayer.replaceChildren();
  clearEdgeGraphics();
  groups = [];
  groupById.clear();
  fileById.clear();
  functionById.clear();
  functionEdges.clear();
  functionViews.clear();
  pendingNodeStates.clear();
  agentsById.clear();
  diagnosticsByNode.clear();
  agentReportsByNode.clear();
  testRunSnapshot = {
    phase: 'idle',
    outcome: null,
    sequence: [],
    failures: {},
    message: null,
    uncovered: []
  };
  uncoveredNodeIds.clear();
  loadedFunctionFiles.clear();
  loadingFunctionFiles.clear();
  expandedFunctionFiles.clear();
  folderByFileId.clear();
  selectedNodeId = undefined;
  annotationSaves.clear();
  manualAnnotation.disabled = false;
  sidebarEmpty.hidden = false;
  nodeDetails.hidden = true;
  diagnosticField.hidden = true;
  nodeDiagnostics.replaceChildren();
  errorSourceField.hidden = true;
  nodeErrorSourceList.replaceChildren();
  testFailureField.hidden = true;
  nodeTestFailures.replaceChildren();
  agentReportField.hidden = true;
  nodeAgentReports.replaceChildren();
  runTestsButton.disabled = false;
  document.body.classList.remove('flash-disabled');
  renderStatusSummary({
    activeAgents: 0,
    editingNodes: 0,
    errorNodes: 0,
    passingNodes: 0
  });
  tooltip.hidden = true;
  renderAgentHierarchy();
}

function fileGridColumns(fileCount: number): number {
  return Math.max(1, Math.min(3, Math.ceil(Math.sqrt(fileCount))));
}

function effectiveAnnotation(node: GraphNode): string | null {
  return node.annotation.manual ?? node.annotation.auto;
}

function truncateAnnotation(annotation: string): string {
  const flattened = annotation.replace(/\s+/g, ' ').trim();
  return flattened.length > 112 ? `${flattened.slice(0, 109)}…` : flattened;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function escapeSelector(value: string): string {
  return CSS.escape(value);
}

function cloneDiagnostic(diagnostic: NodeDiagnostic): NodeDiagnostic {
  return {
    ...diagnostic,
    range: { ...diagnostic.range }
  };
}

function cloneTestRun(snapshot: TestRunSnapshot): TestRunSnapshot {
  return {
    ...snapshot,
    uncovered: [...snapshot.uncovered],
    sequence: [...snapshot.sequence],
    failures: Object.fromEntries(
      Object.entries(snapshot.failures).map(([nodeId, failures]) => [
        nodeId,
        failures.map((failure) => ({ ...failure }))
      ])
    )
  };
}

function requireElement<T extends Element>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`CodeFold 2D webview is missing #${id}.`);
  }
  return element as unknown as T;
}

function requireDescendant<T extends Element>(
  root: ParentNode,
  selector: string
): T {
  const element = root.querySelector(selector);
  if (element === null) {
    throw new Error(`CodeFold 2D webview is missing ${selector}.`);
  }
  return element as T;
}

function isExtensionMessage(
  value: unknown
): value is
  | { type: 'graph'; graph: WebviewGraph }
  | { type: 'functions'; payload: FunctionGraphPayload }
  | { type: 'stateUpdate'; update: NodeStateUpdate }
  | { type: 'error'; message: string }
  | { type: 'testRunError'; message: string }
  | { type: 'annotationSaved'; nodeId: string; manual: string | null }
  | { type: 'annotationSaveError'; nodeId: string; message: string }
  | { type: 'layoutSaved' }
  | { type: 'layoutSaveError'; message: string } {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return false;
  }
  const type = (value as { type: unknown }).type;
  if (type === 'graph') {
    return 'graph' in value;
  }
  if (type === 'functions' && 'payload' in value) {
    const payload = value.payload;
    return (
      typeof payload === 'object'
      && payload !== null
      && 'fileId' in payload
      && typeof payload.fileId === 'string'
      && 'nodes' in payload
      && Array.isArray(payload.nodes)
      && 'edges' in payload
      && Array.isArray(payload.edges)
    );
  }
  if (type === 'stateUpdate' && 'update' in value) {
    const update = value.update;
    return (
      typeof update === 'object'
      && update !== null
      && 'nodes' in update
      && Array.isArray(update.nodes)
      && 'agents' in update
      && Array.isArray(update.agents)
      && (
        !('diagnostics' in update)
        || isNodeDiagnostics(update.diagnostics)
      )
      && (
        !('testRun' in update)
        || isTestRunSnapshot(update.testRun)
      )
      && (
        !('agentReports' in update)
        || isNodeAgentReports(update.agentReports)
      )
      && (
        !('summary' in update)
        || isStatusSummary(update.summary)
      )
      && (
        !('settings' in update)
        || isWebviewSettings(update.settings)
      )
    );
  }
  if (type === 'layoutSaved') {
    return true;
  }
  if (type === 'error' || type === 'layoutSaveError' || type === 'testRunError') {
    return 'message' in value && typeof (value as { message: unknown }).message === 'string';
  }
  return (
    (type === 'annotationSaved' || type === 'annotationSaveError')
    && 'nodeId' in value
    && typeof (value as { nodeId: unknown }).nodeId === 'string'
  );
}

function isNodeAgentReports(value: unknown): value is NodeAgentReports {
  return (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.values(value).every((reports) =>
      Array.isArray(reports) && reports.every(isAgentReportDetail)
    )
  );
}

function isAgentReportDetail(value: unknown): value is AgentReportDetail {
  return (
    typeof value === 'object'
    && value !== null
    && 'id' in value
    && typeof value.id === 'string'
    && 'agentId' in value
    && typeof value.agentId === 'string'
    && 'agentName' in value
    && typeof value.agentName === 'string'
    && 'message' in value
    && typeof value.message === 'string'
    && 'fileId' in value
    && typeof value.fileId === 'string'
    && 'nodeId' in value
    && typeof value.nodeId === 'string'
    && 'createdAt' in value
    && typeof value.createdAt === 'string'
  );
}

function isStatusSummary(value: unknown): value is StatusSummary {
  return (
    typeof value === 'object'
    && value !== null
    && 'activeAgents' in value
    && isNonNegativeInteger(value.activeAgents)
    && 'editingNodes' in value
    && isNonNegativeInteger(value.editingNodes)
    && 'errorNodes' in value
    && isNonNegativeInteger(value.errorNodes)
    && 'passingNodes' in value
    && isNonNegativeInteger(value.passingNodes)
  );
}

function isWebviewSettings(value: unknown): value is WebviewSettings {
  return (
    typeof value === 'object'
    && value !== null
    && 'flashAnimations' in value
    && typeof value.flashAnimations === 'boolean'
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isTestRunSnapshot(value: unknown): value is TestRunSnapshot {
  if (
    typeof value !== 'object'
    || value === null
    || !('phase' in value)
    || (
      value.phase !== 'idle'
      && value.phase !== 'running'
      && value.phase !== 'flow'
      && value.phase !== 'complete'
    )
    || !('outcome' in value)
    || (
      value.outcome !== null
      && value.outcome !== 'passed'
      && value.outcome !== 'failed'
    )
    || !('sequence' in value)
    || !Array.isArray(value.sequence)
    || !value.sequence.every((nodeId) => typeof nodeId === 'string')
    || !('failures' in value)
    || typeof value.failures !== 'object'
    || value.failures === null
    || Array.isArray(value.failures)
    || !('message' in value)
    || (value.message !== null && typeof value.message !== 'string')
  ) {
    return false;
  }
  return Object.values(value.failures).every((failures) =>
    Array.isArray(failures) && failures.every(isTestFailureDetail)
  );
}

function isTestFailureDetail(value: unknown): value is TestFailureDetail {
  return (
    typeof value === 'object'
    && value !== null
    && 'id' in value
    && typeof value.id === 'string'
    && 'testName' in value
    && typeof value.testName === 'string'
    && 'message' in value
    && typeof value.message === 'string'
    && 'stack' in value
    && typeof value.stack === 'string'
    && 'source' in value
    && (value.source === 'test' || value.source === 'runtime')
    && 'fileId' in value
    && typeof value.fileId === 'string'
    && 'line' in value
    && typeof value.line === 'number'
    && Number.isInteger(value.line)
    && value.line >= 0
    && 'character' in value
    && typeof value.character === 'number'
    && Number.isInteger(value.character)
    && value.character >= 0
  );
}

function isNodeDiagnostics(value: unknown): value is NodeDiagnostics {
  return (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.values(value).every((diagnostics) =>
      Array.isArray(diagnostics)
      && diagnostics.every((diagnostic) =>
        typeof diagnostic === 'object'
        && diagnostic !== null
        && 'id' in diagnostic
        && typeof diagnostic.id === 'string'
        && 'fileId' in diagnostic
        && typeof diagnostic.fileId === 'string'
        && 'source' in diagnostic
        && typeof diagnostic.source === 'string'
        && 'message' in diagnostic
        && typeof diagnostic.message === 'string'
        && 'severity' in diagnostic
        && (
          diagnostic.severity === 'error'
          || diagnostic.severity === 'warning'
          || diagnostic.severity === 'information'
          || diagnostic.severity === 'hint'
        )
        && 'range' in diagnostic
        && typeof diagnostic.range === 'object'
        && diagnostic.range !== null
        && 'startLine' in diagnostic.range
        && typeof diagnostic.range.startLine === 'number'
        && Number.isInteger(diagnostic.range.startLine)
        && diagnostic.range.startLine >= 0
        && 'startCharacter' in diagnostic.range
        && typeof diagnostic.range.startCharacter === 'number'
        && Number.isInteger(diagnostic.range.startCharacter)
        && diagnostic.range.startCharacter >= 0
        && 'endLine' in diagnostic.range
        && typeof diagnostic.range.endLine === 'number'
        && Number.isInteger(diagnostic.range.endLine)
        && diagnostic.range.endLine >= 0
        && 'endCharacter' in diagnostic.range
        && typeof diagnostic.range.endCharacter === 'number'
        && Number.isInteger(diagnostic.range.endCharacter)
        && diagnostic.range.endCharacter >= 0
      )
    )
  );
}
