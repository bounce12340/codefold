import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum
} from 'd3-force-3d';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { GraphEdge, GraphNode, WebviewGraph } from '../scanner/model';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
};

interface LayoutNode extends SimulationNodeDatum {
  id: string;
  graphNode: GraphNode;
  x: number;
  y: number;
  z: number;
}

interface LayoutLink extends SimulationLinkDatum<LayoutNode> {
  source: string | LayoutNode;
  target: string | LayoutNode;
}

interface LabelEntry {
  sprite: THREE.Sprite;
  texture: THREE.CanvasTexture;
}

const vscode = acquireVsCodeApi();
const container = requireElement<HTMLDivElement>('scene');
const status = requireElement<HTMLDivElement>('status');
const warning = requireElement<HTMLDivElement>('warning');
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
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 5_000);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
const controls = new OrbitControls(camera, renderer.domElement);
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const pointerStart = new THREE.Vector2();
let nodeMesh: THREE.InstancedMesh | undefined;
let labelGroup: THREE.Group | undefined;
let nodes: LayoutNode[] = [];
const labelEntries = new Map<string, LabelEntry>();
let hoveredNode = -1;
let selectedNode = -1;

camera.position.set(0, 0, 220);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
container.append(renderer.domElement);
controls.enableDamping = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = true;
controls.minDistance = 20;
controls.maxDistance = 2_000;

scene.add(new THREE.AmbientLight(0xffffff, 1.25));
const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
keyLight.position.set(120, 160, 200);
scene.add(keyLight);

const resizeObserver = new ResizeObserver(resize);
resizeObserver.observe(container);
renderer.domElement.addEventListener('pointerdown', onPointerDown);
renderer.domElement.addEventListener('pointerup', onPointerUp);
renderer.domElement.addEventListener('pointermove', onPointerMove);
renderer.domElement.addEventListener('dblclick', onDoubleClick);
renderer.domElement.addEventListener('pointerleave', () => {
  hoveredNode = -1;
  tooltip.style.display = 'none';
  renderer.domElement.style.cursor = 'grab';
});
resetViewButton.addEventListener('click', () => frameGraph(nodes));
saveAnnotationButton.addEventListener('click', saveSelectedAnnotation);
openFileButton.addEventListener('click', openSelectedFile);

window.addEventListener('message', (event: MessageEvent<unknown>) => {
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
  if (
    selectedNode >= 0
    && nodes[selectedNode]?.id === event.data.nodeId
  ) {
    saveAnnotationButton.disabled = false;
    saveStatus.textContent = `Save failed: ${event.data.message}`;
    saveStatus.classList.add('error');
  }
});

vscode.postMessage({ type: 'ready' });
resize();
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

function renderGraph(graph: WebviewGraph): void {
  clearGraph();
  status.textContent = `${graph.nodes.length} files · ${graph.edges.length} imports`;
  if (graph.truncated) {
    warning.textContent =
      `Large workspace: showing the first 2,000 of ${graph.totalFiles} supported files.`;
    warning.style.display = 'block';
  } else {
    warning.style.display = 'none';
  }
  if (graph.nodes.length === 0) {
    return;
  }

  nodes = layoutGraph(graph);
  addEdges(graph.edges, nodes);
  addNodes(nodes);
  addLabels(nodes);
  frameGraph(nodes);
}

function layoutGraph(graph: WebviewGraph): LayoutNode[] {
  const random = seededRandom(graph.seed);
  const layoutNodes = graph.nodes.map((graphNode) => {
    const radius = 65 * Math.cbrt(random());
    const theta = random() * Math.PI * 2;
    const phi = Math.acos(2 * random() - 1);
    return {
      id: graphNode.id,
      graphNode,
      x: radius * Math.sin(phi) * Math.cos(theta),
      y: radius * Math.sin(phi) * Math.sin(theta),
      z: radius * Math.cos(phi)
    };
  });
  const links: LayoutLink[] = graph.edges.map((edge) => ({
    source: edge.from,
    target: edge.to
  }));
  const simulation = forceSimulation<LayoutNode>(layoutNodes, 3)
    .randomSource(seededRandom(graph.seed ^ 0x9e3779b9))
    .force(
      'link',
      forceLink<LayoutNode, LayoutLink>(links)
        .id((node) => node.id)
        .distance(22)
        .strength(0.72)
    )
    .force('charge', forceManyBody().strength(-52).distanceMax(360))
    .force('center', forceCenter(0, 0, 0))
    .force('collision', forceCollide(7).strength(0.9))
    .stop();
  const ticks = graph.nodes.length > 1_000 ? 110 : graph.nodes.length > 400 ? 150 : 220;
  for (let index = 0; index < ticks; index += 1) {
    simulation.tick();
  }
  simulation.stop();
  return layoutNodes;
}

function addNodes(layoutNodes: readonly LayoutNode[]): void {
  const geometry = new THREE.CapsuleGeometry(2, 7, 6, 12);
  geometry.rotateZ(Math.PI / 2);
  const material = new THREE.MeshStandardMaterial({
    color: 0x7891a8,
    roughness: 0.55,
    metalness: 0.12
  });
  nodeMesh = new THREE.InstancedMesh(geometry, material, layoutNodes.length);
  nodeMesh.name = 'codefold-nodes';
  updateNodeTransforms();
  scene.add(nodeMesh);
}

function addLabels(layoutNodes: readonly LayoutNode[]): void {
  labelGroup = new THREE.Group();
  labelGroup.name = 'codefold-labels';
  for (const node of layoutNodes) {
    const entry = createLabel(node);
    labelEntries.set(node.id, entry);
    labelGroup.add(entry.sprite);
  }
  scene.add(labelGroup);
}

function createLabel(node: LayoutNode): LabelEntry {
  const { texture, width, height } = createLabelTexture(node.graphNode);
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false
  });
  const sprite = new THREE.Sprite(material);
  const scale = 0.04;
  sprite.scale.set(width * scale, height * scale, 1);
  sprite.position.set(node.x, node.y, node.z);
  sprite.renderOrder = 2;
  return { sprite, texture };
}

function createLabelTexture(graphNode: GraphNode): {
  texture: THREE.CanvasTexture;
  width: number;
  height: number;
} {
  const annotation = truncateLabelAnnotation(effectiveAnnotation(graphNode));
  const canvas = document.createElement('canvas');
  const measurementContext = canvas.getContext('2d');
  if (measurementContext === null) {
    throw new Error('Could not create the canvas context for node labels.');
  }
  measurementContext.font = '600 20px system-ui, sans-serif';
  const nameWidth = measurementContext.measureText(graphNode.name).width;
  measurementContext.font = '13px system-ui, sans-serif';
  const annotationWidth = annotation === null
    ? 0
    : measurementContext.measureText(annotation).width;
  const width = Math.ceil(Math.min(360, Math.max(120, nameWidth, annotationWidth) + 20));
  const height = annotation === null ? 42 : 64;
  const pixelRatio = 1;
  canvas.width = width * pixelRatio;
  canvas.height = height * pixelRatio;

  const context = canvas.getContext('2d');
  if (context === null) {
    throw new Error('Could not create the canvas context for node labels.');
  }
  context.scale(pixelRatio, pixelRatio);
  context.fillStyle = 'rgba(19, 28, 37, 0.84)';
  roundRect(context, 0, 0, width, height, 6);
  context.fill();
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = '#f2f5f7';
  context.font = '600 20px system-ui, sans-serif';
  context.fillText(fitCanvasText(context, graphNode.name, width - 16), width / 2, 19);
  if (annotation !== null) {
    context.fillStyle = '#c3ced7';
    context.font = '13px system-ui, sans-serif';
    context.fillText(fitCanvasText(context, annotation, width - 16), width / 2, 47);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return { texture, width, height };
}

function addEdges(
  graphEdges: readonly GraphEdge[],
  layoutNodes: readonly LayoutNode[]
): void {
  const positionsById = new Map(layoutNodes.map((node) => [node.id, node]));
  const positions: number[] = [];
  for (const edge of graphEdges) {
    const source = positionsById.get(edge.from);
    const target = positionsById.get(edge.to);
    if (source === undefined || target === undefined) {
      continue;
    }
    positions.push(source.x, source.y, source.z, target.x, target.y, target.z);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const material = new THREE.LineBasicMaterial({
    color: 0x5b7083,
    transparent: true,
    opacity: 0.44
  });
  const lines = new THREE.LineSegments(geometry, material);
  lines.name = 'codefold-edges';
  scene.add(lines);
}

function frameGraph(layoutNodes: readonly LayoutNode[]): void {
  if (layoutNodes.length === 0) {
    return;
  }
  const bounds = new THREE.Box3();
  for (const node of layoutNodes) {
    bounds.expandByPoint(new THREE.Vector3(node.x, node.y, node.z));
  }
  const sphere = bounds.getBoundingSphere(new THREE.Sphere());
  sphere.radius += 12;
  const verticalFov = THREE.MathUtils.degToRad(camera.fov);
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
  const fittingFov = Math.min(verticalFov, horizontalFov);
  const distance = Math.max(60, sphere.radius / Math.sin(fittingFov / 2));
  camera.position.set(sphere.center.x, sphere.center.y, sphere.center.z + distance * 1.08);
  controls.target.copy(sphere.center);
  camera.lookAt(sphere.center);
  controls.update();
}

function clearGraph(): void {
  for (const object of [...scene.children]) {
    if (
      object.name !== 'codefold-nodes'
      && object.name !== 'codefold-edges'
      && object.name !== 'codefold-labels'
    ) {
      continue;
    }
    scene.remove(object);
    object.traverse((child) => {
      if ('geometry' in child && child.geometry instanceof THREE.BufferGeometry) {
        child.geometry.dispose();
      }
      if ('material' in child) {
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        for (const material of materials) {
          if ('map' in material && material.map instanceof THREE.Texture) {
            material.map.dispose();
          }
          material.dispose();
        }
      }
    });
  }
  nodeMesh = undefined;
  labelGroup = undefined;
  labelEntries.clear();
  nodes = [];
  hoveredNode = -1;
  selectedNode = -1;
  sidebarEmpty.hidden = false;
  nodeDetails.hidden = true;
  tooltip.style.display = 'none';
}

function onPointerDown(event: PointerEvent): void {
  pointerStart.set(event.clientX, event.clientY);
}

function onPointerUp(event: PointerEvent): void {
  const movement = pointerStart.distanceTo(new THREE.Vector2(event.clientX, event.clientY));
  if (movement > 5) {
    return;
  }
  const nodeIndex = pickNode(event);
  if (nodeIndex >= 0) {
    selectNode(nodeIndex);
  }
}

function onDoubleClick(event: MouseEvent): void {
  const nodeIndex = pickNode(event);
  if (nodeIndex < 0) {
    return;
  }
  selectNode(nodeIndex);
  vscode.postMessage({ type: 'openFile', nodeId: nodes[nodeIndex].id });
}

function onPointerMove(event: PointerEvent): void {
  const nodeIndex = pickNode(event);
  if (nodeIndex < 0) {
    hoveredNode = -1;
    tooltip.style.display = 'none';
    renderer.domElement.style.cursor = 'grab';
    return;
  }
  hoveredNode = nodeIndex;
  tooltip.textContent = tooltipText(nodes[hoveredNode].graphNode);
  tooltip.style.left = `${event.clientX + 12}px`;
  tooltip.style.top = `${event.clientY + 12}px`;
  tooltip.style.display = 'block';
  renderer.domElement.style.cursor = 'pointer';
}

function pickNode(event: MouseEvent | PointerEvent): number {
  if (nodeMesh === undefined) {
    return -1;
  }
  const bounds = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
  pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObject(nodeMesh, false)[0];
  return hit?.instanceId ?? -1;
}

function selectNode(nodeIndex: number): void {
  selectedNode = nodeIndex;
  updateNodeTransforms();
  sidebarEmpty.hidden = true;
  nodeDetails.hidden = false;
  showSelectedNode();
}

function showSelectedNode(): void {
  const selected = nodes[selectedNode]?.graphNode;
  if (selected === undefined) {
    return;
  }
  nodeName.textContent = selected.name;
  nodePath.textContent = selected.path;
  nodeLanguage.textContent = selected.lang;
  autoAnnotation.textContent = selected.annotation.auto ?? 'No file-header annotation found.';
  manualAnnotation.value = selected.annotation.manual ?? '';
  saveAnnotationButton.disabled = false;
  saveStatus.textContent = '';
  saveStatus.classList.remove('error');
}

function saveSelectedAnnotation(): void {
  const selected = nodes[selectedNode];
  if (selected === undefined) {
    return;
  }
  saveAnnotationButton.disabled = true;
  saveStatus.textContent = 'Saving…';
  saveStatus.classList.remove('error');
  vscode.postMessage({
    type: 'saveAnnotation',
    nodeId: selected.id,
    manual: manualAnnotation.value
  });
}

function openSelectedFile(): void {
  const selected = nodes[selectedNode];
  if (selected !== undefined) {
    vscode.postMessage({ type: 'openFile', nodeId: selected.id });
  }
}

function applySavedAnnotation(nodeId: string, manual: string | null): void {
  const nodeIndex = nodes.findIndex((node) => node.id === nodeId);
  if (nodeIndex < 0) {
    return;
  }
  nodes[nodeIndex].graphNode.annotation.manual = manual;
  refreshLabel(nodes[nodeIndex]);
  if (selectedNode === nodeIndex) {
    manualAnnotation.value = manual ?? '';
    saveAnnotationButton.disabled = false;
    saveStatus.textContent = 'Saved.';
    saveStatus.classList.remove('error');
  }
}

function refreshLabel(node: LayoutNode): void {
  const previous = labelEntries.get(node.id);
  if (previous === undefined || labelGroup === undefined) {
    return;
  }
  labelGroup.remove(previous.sprite);
  previous.texture.dispose();
  previous.sprite.material.dispose();
  const replacement = createLabel(node);
  labelEntries.set(node.id, replacement);
  labelGroup.add(replacement.sprite);
}

function updateNodeTransforms(): void {
  if (nodeMesh === undefined) {
    return;
  }
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    position.set(node.x, node.y, node.z);
    scale.setScalar(index === selectedNode ? 1.12 : 1);
    matrix.compose(position, rotation, scale);
    nodeMesh.setMatrixAt(index, matrix);
  }
  nodeMesh.instanceMatrix.needsUpdate = true;
}

function effectiveAnnotation(graphNode: GraphNode): string | null {
  return graphNode.annotation.manual ?? graphNode.annotation.auto;
}

function tooltipText(graphNode: GraphNode): string {
  const details = [graphNode.path];
  if (graphNode.annotation.manual !== null) {
    details.push(`Manual: ${graphNode.annotation.manual}`);
  }
  if (graphNode.annotation.auto !== null) {
    details.push(`Auto: ${graphNode.annotation.auto}`);
  }
  if (details.length === 1) {
    details.push('Annotation: none');
  }
  return details.join('\n');
}

function truncateLabelAnnotation(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const characters = [...value.replace(/\s+/g, ' ').trim()];
  return characters.length > 40
    ? `${characters.slice(0, 40).join('')}…`
    : characters.join('');
}

function fitCanvasText(
  context: CanvasRenderingContext2D,
  value: string,
  maxWidth: number
): string {
  if (context.measureText(value).width <= maxWidth) {
    return value;
  }
  const characters = [...value];
  while (
    characters.length > 1
    && context.measureText(`${characters.join('')}…`).width > maxWidth
  ) {
    characters.pop();
  }
  return `${characters.join('')}…`;
}

function roundRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

function resize(): void {
  const width = Math.max(1, container.clientWidth);
  const height = Math.max(1, container.clientHeight);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
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

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Missing required webview element: ${id}`);
  }
  return element as T;
}

function isExtensionMessage(
  value: unknown
): value is
  | { type: 'graph'; graph: WebviewGraph }
  | { type: 'error'; message: string }
  | { type: 'annotationSaved'; nodeId: string; manual: string | null }
  | { type: 'annotationSaveError'; nodeId: string; message: string } {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return false;
  }
  const type = (value as { type: unknown }).type;
  if (type === 'graph') {
    return 'graph' in value;
  }
  if (
    type === 'annotationSaved'
    && 'nodeId' in value
    && typeof (value as { nodeId: unknown }).nodeId === 'string'
    && 'manual' in value
  ) {
    const manual = (value as { manual: unknown }).manual;
    return manual === null || typeof manual === 'string';
  }
  if (
    type === 'annotationSaveError'
    && 'nodeId' in value
    && typeof (value as { nodeId: unknown }).nodeId === 'string'
    && 'message' in value
    && typeof (value as { message: unknown }).message === 'string'
  ) {
    return true;
  }
  return type === 'error'
    && 'message' in value
    && typeof (value as { message: unknown }).message === 'string';
}
