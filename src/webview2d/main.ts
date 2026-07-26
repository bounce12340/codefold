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
  GraphEdge,
  GraphNode,
  GroupLayout,
  LayoutPoint,
  WebviewGraph,
  WorkspaceLayout
} from '../scanner/model';
import { AnnotationSaveTracker } from './annotationSaveTracker';

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
const warning = requireElement<HTMLDivElement>('warning');
const layoutWarning = requireElement<HTMLDivElement>('layout-warning');
const tooltip = requireElement<HTMLDivElement>('tooltip');
const resetViewButton = requireElement<HTMLButtonElement>('reset-view');
const sidebarEmpty = requireElement<HTMLParagraphElement>('sidebar-empty');
const nodeDetails = requireElement<HTMLDivElement>('node-details');
const nodeName = requireElement<HTMLParagraphElement>('node-name');
const nodePath = requireElement<HTMLParagraphElement>('node-path');
const nodeLanguage = requireElement<HTMLParagraphElement>('node-language');
const autoAnnotation = requireElement<HTMLParagraphElement>('auto-annotation');
const manualAnnotation = requireElement<HTMLTextAreaElement>('manual-annotation');
const saveAnnotationButton = requireElement<HTMLButtonElement>('save-annotation');
const openFileButton = requireElement<HTMLButtonElement>('open-file');
const saveStatus = requireElement<HTMLDivElement>('save-status');

let graph: WebviewGraph | undefined;
let groups: GroupView[] = [];
let groupById = new Map<string, GroupView>();
let fileById = new Map<string, GraphNode>();
let folderByFileId = new Map<string, string>();
let selectedFileId: string | undefined;
const annotationSaves = new AnnotationSaveTracker();
let camera = { x: 0, y: 0, scale: 1 };
let edgeFrame: number | undefined;
let panState:
  | { pointerId: number; startX: number; startY: number; cameraX: number; cameraY: number }
  | undefined;

resetViewButton.addEventListener('click', fitToContent);
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
  if (selectedFileId === event.data.nodeId) {
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

  status.textContent =
    `${groups.length} folders · ${nextGraph.nodes.length} files · ${nextGraph.edges.length} imports`;
  if (nextGraph.truncated) {
    warning.textContent =
      `Large workspace: showing the first 2,000 of ${nextGraph.totalFiles} supported files.`;
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
  group.expanded = !group.expanded;
  updateGroupGeometry(group);
  if (group.expanded) {
    renderGroupFiles(group);
  } else {
    group.filesElement.replaceChildren();
  }
  const header = requireDescendant<HTMLButtonElement>(
    group.element,
    '.folder-header'
  );
  header.title = `${group.expanded ? 'Collapse' : 'Expand'} ${group.group.name}`;
  drawEdges();
  persistLayout();
}

function updateGroupGeometry(group: GroupView): void {
  if (group.expanded) {
    const columns = fileGridColumns(group.group.files.length);
    const rows = Math.ceil(group.group.files.length / columns);
    group.width =
      GROUP_PADDING * 2 + columns * FILE_WIDTH + Math.max(0, columns - 1) * FILE_GAP_X;
    group.height =
      GROUP_HEADER_HEIGHT + GROUP_PADDING + rows * FILE_HEIGHT
      + Math.max(0, rows - 1) * FILE_GAP_Y + GROUP_PADDING;
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
  group.filesElement.replaceChildren();
  const columns = fileGridColumns(group.group.files.length);
  for (const [index, file] of group.group.files.entries()) {
    const defaultPosition = {
      x: GROUP_PADDING + (index % columns) * (FILE_WIDTH + FILE_GAP_X),
      y: GROUP_HEADER_HEIGHT + GROUP_PADDING
        + Math.floor(index / columns) * (FILE_HEIGHT + FILE_GAP_Y)
    };
    const position = group.filePositions.get(file.id) ?? defaultPosition;
    position.x = clamp(position.x, GROUP_PADDING, group.width - FILE_WIDTH - GROUP_PADDING);
    position.y = clamp(
      position.y,
      GROUP_HEADER_HEIGHT + GROUP_PADDING,
      group.height - FILE_HEIGHT - GROUP_PADDING
    );
    group.filePositions.set(file.id, position);
    group.filesElement.append(createFileCard(group, file, position));
  }
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
    `<div class="file-title"><span class="file-name"></span>`
    + `<span class="language-badge"></span></div>`
    + `<div class="file-annotation"></div>`;
  requireDescendant<HTMLElement>(card, '.file-name').textContent = file.name;
  requireDescendant<HTMLElement>(card, '.language-badge').textContent = file.lang;
  updateFileCardContent(card, file);
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
    position.x = clamp(
      drag.originalX + dx,
      GROUP_PADDING,
      group.width - FILE_WIDTH - GROUP_PADDING
    );
    position.y = clamp(
      drag.originalY + dy,
      GROUP_HEADER_HEIGHT + GROUP_PADDING,
      group.height - FILE_HEIGHT - GROUP_PADDING
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
    selectFile(file.id);
  });
  card.addEventListener('dblclick', () => {
    vscode.postMessage({ type: 'openFile', nodeId: file.id });
  });
  card.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      vscode.postMessage({ type: 'openFile', nodeId: file.id });
    } else if (event.key === ' ') {
      event.preventDefault();
      selectFile(file.id);
    }
  });
  return card;
}

function positionFileCard(card: HTMLElement, position: LayoutPoint): void {
  card.style.transform = `translate(${position.x}px, ${position.y}px)`;
}

function updateFileCardContent(card: HTMLElement, file: GraphNode): void {
  const annotation = effectiveAnnotation(file);
  requireDescendant<HTMLElement>(card, '.file-annotation').textContent =
    annotation === null ? '' : truncateAnnotation(annotation);
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

function selectFile(nodeId: string): void {
  selectedFileId = nodeId;
  for (const card of Array.from(
    nodeLayer.querySelectorAll<HTMLElement>('.file-card')
  )) {
    card.classList.toggle('selected', card.dataset.nodeId === nodeId);
  }
  const file = fileById.get(nodeId);
  if (file === undefined) {
    return;
  }
  sidebarEmpty.hidden = true;
  nodeDetails.hidden = false;
  nodeName.textContent = file.name;
  nodePath.textContent = file.path;
  nodeLanguage.textContent = file.lang;
  autoAnnotation.textContent = file.annotation.auto ?? 'No automatic annotation.';
  manualAnnotation.value = file.annotation.manual ?? '';
  const savePending = annotationSaves.isPending(nodeId);
  saveAnnotationButton.disabled = savePending;
  saveStatus.textContent = savePending
    ? (
      annotationSaves.hasNewerPendingDraft(nodeId)
        ? 'Saving previous version; newer changes are still unsaved.'
        : 'Saving…'
    )
    : (annotationSaves.hasDraft(nodeId) ? 'Unsaved changes' : '');
  saveStatus.classList.remove('error');
}

function previewManualAnnotation(): void {
  if (selectedFileId === undefined) {
    return;
  }
  const file = fileById.get(selectedFileId);
  if (file === undefined) {
    return;
  }
  file.annotation.manual =
    manualAnnotation.value.trim().length === 0 ? null : manualAnnotation.value;
  annotationSaves.setDraft(selectedFileId, manualAnnotation.value);
  const card = nodeLayer.querySelector<HTMLElement>(
    `.file-card[data-node-id="${escapeSelector(selectedFileId)}"]`
  );
  if (card !== null) {
    updateFileCardContent(card, file);
  }
  saveStatus.textContent = 'Unsaved changes';
  saveStatus.classList.remove('error');
}

function saveSelectedAnnotation(): void {
  if (selectedFileId === undefined) {
    return;
  }
  if (!annotationSaves.begin(selectedFileId, manualAnnotation.value)) {
    saveAnnotationButton.disabled = true;
    saveStatus.textContent = 'A save is already in progress for this file.';
    return;
  }
  saveAnnotationButton.disabled = true;
  saveStatus.textContent = 'Saving…';
  saveStatus.classList.remove('error');
  vscode.postMessage({
    type: 'saveAnnotation',
    nodeId: selectedFileId,
    manual: manualAnnotation.value
  });
}

function openSelectedFile(): void {
  if (selectedFileId !== undefined) {
    vscode.postMessage({ type: 'openFile', nodeId: selectedFileId });
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
  if (selectedFileId === nodeId) {
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
  const edges = visibleEdges(graph.edges);
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
    path.setAttribute('class', visibleEdge.count > 1 ? 'dependency aggregate' : 'dependency');
    path.setAttribute('marker-end', 'url(#dependency-arrow)');
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
}

function visibleEdges(edges: readonly GraphEdge[]): VisibleEdge[] {
  const counts = new Map<string, VisibleEdge>();
  for (const edge of edges) {
    if (edge.kind !== 'import') {
      continue;
    }
    const sourceGroupId = folderByFileId.get(edge.from);
    const targetGroupId = folderByFileId.get(edge.to);
    if (sourceGroupId === undefined || targetGroupId === undefined) {
      continue;
    }
    const sourceGroup = groupById.get(sourceGroupId);
    const targetGroup = groupById.get(targetGroupId);
    if (sourceGroup === undefined || targetGroup === undefined) {
      continue;
    }
    if (sourceGroupId === targetGroupId && !sourceGroup.expanded) {
      continue;
    }
    const source = sourceGroup.expanded ? edge.from : sourceGroupId;
    const target = targetGroup.expanded ? edge.to : targetGroupId;
    if (source === target) {
      continue;
    }
    const key = edgeKey(source, target);
    const existing = counts.get(key);
    if (existing === undefined) {
      counts.set(key, { from: source, to: target, count: 1 });
    } else {
      existing.count += 1;
    }
  }
  return [...counts.values()];
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
  folderByFileId.clear();
  selectedFileId = undefined;
  annotationSaves.clear();
  sidebarEmpty.hidden = false;
  nodeDetails.hidden = true;
  tooltip.hidden = true;
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
  | { type: 'error'; message: string }
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
  if (type === 'layoutSaved') {
    return true;
  }
  if (type === 'error' || type === 'layoutSaveError') {
    return 'message' in value && typeof (value as { message: unknown }).message === 'string';
  }
  return (
    (type === 'annotationSaved' || type === 'annotationSaveError')
    && 'nodeId' in value
    && typeof (value as { nodeId: unknown }).nodeId === 'string'
  );
}
