import type {
  DependencyCoupling,
  DependencyCycle,
  DependencyHealth,
  GraphEdge,
  GraphNode
} from '../scanner/model';
import { folderId, folderKeyForPath } from './folders';

// The shapes live in scanner/model.ts with the rest of the wire types. Defining
// them here and importing them from there would create an import cycle between
// the model and this module — exactly what analyzeDependencyHealth reports on.
export type { DependencyCoupling, DependencyCycle, DependencyHealth };

export function edgeKey(from: string, to: string): string {
  return `${from}\0${to}`;
}

/**
 * Import-level only, deliberately. Call edges recurse by design — a recursive
 * or mutually recursive function is ordinary code, not a structural defect —
 * so folding them in here would bury the real import cycles in false alarms.
 */
export function analyzeDependencyHealth(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[]
): DependencyHealth {
  const files = new Set(
    nodes.filter((node) => node.kind === 'file').map((node) => node.id)
  );
  const outgoing = new Map<string, string[]>();
  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();
  for (const fileId of files) {
    outgoing.set(fileId, []);
    fanIn.set(fileId, 0);
    fanOut.set(fileId, 0);
  }

  const seenEdges = new Set<string>();
  for (const edge of edges) {
    if (
      edge.kind !== 'import'
      || !files.has(edge.from)
      || !files.has(edge.to)
      || edge.from === edge.to
    ) {
      continue;
    }
    const key = edgeKey(edge.from, edge.to);
    if (seenEdges.has(key)) {
      continue;
    }
    seenEdges.add(key);
    outgoing.get(edge.from)?.push(edge.to);
    fanOut.set(edge.from, (fanOut.get(edge.from) ?? 0) + 1);
    fanIn.set(edge.to, (fanIn.get(edge.to) ?? 0) + 1);
  }
  for (const targets of outgoing.values()) {
    targets.sort((left, right) => left.localeCompare(right));
  }

  const components = stronglyConnectedComponents(
    [...files].sort((left, right) => left.localeCompare(right)),
    outgoing
  );

  const cycles: DependencyCycle[] = [];
  const cyclicNodeIds = new Set<string>();
  const cyclicEdgeKeys: string[] = [];
  for (const component of components) {
    if (component.length < 2) {
      continue;
    }
    const members = [...component].sort((left, right) => left.localeCompare(right));
    cycles.push({ id: `cycle:${members.join('|')}`, nodeIds: members });
    const memberSet = new Set(members);
    for (const member of members) {
      cyclicNodeIds.add(member);
      for (const target of outgoing.get(member) ?? []) {
        if (memberSet.has(target)) {
          cyclicEdgeKeys.push(edgeKey(member, target));
        }
      }
    }
  }
  cycles.sort((left, right) => left.id.localeCompare(right.id));
  cyclicEdgeKeys.sort((left, right) => left.localeCompare(right));

  const coupling = [...files]
    .map((nodeId) => ({
      nodeId,
      fanIn: fanIn.get(nodeId) ?? 0,
      fanOut: fanOut.get(nodeId) ?? 0
    }))
    .filter((entry) => entry.fanIn > 0 || entry.fanOut > 0)
    .sort((left, right) =>
      (right.fanIn + right.fanOut) - (left.fanIn + left.fanOut)
      || left.nodeId.localeCompare(right.nodeId)
    );

  const folder = analyzeFolderLayer(files, outgoing);

  return {
    cycles,
    cyclicNodeIds: [...cyclicNodeIds].sort((left, right) => left.localeCompare(right)),
    cyclicEdgeKeys,
    coupling,
    ...folder
  };
}

/**
 * Folders are the default view — everything starts collapsed — so a cycle that
 * is only marked on file cards is invisible until someone expands the right
 * group. Collapsing the same import edges onto their folders surfaces it at the
 * level the user actually looks at first.
 *
 * Only edges that cross a folder boundary count: a cycle wholly inside one
 * folder is a file-level finding and would otherwise make its folder appear to
 * depend on itself.
 */
function analyzeFolderLayer(
  files: ReadonlySet<string>,
  outgoing: ReadonlyMap<string, readonly string[]>
): Pick<
  DependencyHealth,
  'folderCycles' | 'cyclicFolderIds' | 'cyclicFolderEdgeKeys'
> {
  const folderOf = new Map<string, string>();
  for (const fileId of files) {
    folderOf.set(fileId, folderId(folderKeyForPath(fileId)));
  }

  const folderOutgoing = new Map<string, Set<string>>();
  for (const folder of folderOf.values()) {
    if (!folderOutgoing.has(folder)) {
      folderOutgoing.set(folder, new Set());
    }
  }
  for (const [fileId, targets] of outgoing) {
    const from = folderOf.get(fileId);
    if (from === undefined) {
      continue;
    }
    for (const target of targets) {
      const to = folderOf.get(target);
      if (to === undefined || to === from) {
        continue;
      }
      folderOutgoing.get(from)?.add(to);
    }
  }

  const adjacency = new Map<string, string[]>(
    [...folderOutgoing].map(([from, targets]) => [
      from,
      [...targets].sort((left, right) => left.localeCompare(right))
    ])
  );
  const components = stronglyConnectedComponents(
    [...adjacency.keys()].sort((left, right) => left.localeCompare(right)),
    adjacency
  );

  const folderCycles: DependencyCycle[] = [];
  const cyclicFolderIds = new Set<string>();
  const cyclicFolderEdgeKeys: string[] = [];
  for (const component of components) {
    if (component.length < 2) {
      continue;
    }
    const members = [...component].sort((left, right) => left.localeCompare(right));
    folderCycles.push({ id: `cycle:${members.join('|')}`, nodeIds: members });
    const memberSet = new Set(members);
    for (const member of members) {
      cyclicFolderIds.add(member);
      for (const target of adjacency.get(member) ?? []) {
        if (memberSet.has(target)) {
          cyclicFolderEdgeKeys.push(edgeKey(member, target));
        }
      }
    }
  }
  folderCycles.sort((left, right) => left.id.localeCompare(right.id));
  cyclicFolderEdgeKeys.sort((left, right) => left.localeCompare(right));

  return {
    folderCycles,
    cyclicFolderIds: [...cyclicFolderIds].sort((left, right) =>
      left.localeCompare(right)),
    cyclicFolderEdgeKeys
  };
}

/**
 * Tarjan, written iteratively on purpose: the recursive form nests once per
 * node, and a 2000-file workspace (MAX_FILES) chained end to end would put the
 * whole scan at the mercy of the JS stack limit.
 */
function stronglyConnectedComponents(
  orderedNodes: readonly string[],
  outgoing: ReadonlyMap<string, readonly string[]>
): string[][] {
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let nextIndex = 0;

  for (const root of orderedNodes) {
    if (index.has(root)) {
      continue;
    }
    const work: Array<{ node: string; childIndex: number }> = [
      { node: root, childIndex: 0 }
    ];
    index.set(root, nextIndex);
    lowlink.set(root, nextIndex);
    nextIndex += 1;
    stack.push(root);
    onStack.add(root);

    while (work.length > 0) {
      const frame = work[work.length - 1];
      const targets = outgoing.get(frame.node) ?? [];
      if (frame.childIndex < targets.length) {
        const target = targets[frame.childIndex];
        frame.childIndex += 1;
        if (!index.has(target)) {
          index.set(target, nextIndex);
          lowlink.set(target, nextIndex);
          nextIndex += 1;
          stack.push(target);
          onStack.add(target);
          work.push({ node: target, childIndex: 0 });
        } else if (onStack.has(target)) {
          lowlink.set(
            frame.node,
            Math.min(lowlink.get(frame.node) ?? 0, index.get(target) ?? 0)
          );
        }
        continue;
      }

      work.pop();
      const parent = work[work.length - 1];
      if (parent) {
        lowlink.set(
          parent.node,
          Math.min(lowlink.get(parent.node) ?? 0, lowlink.get(frame.node) ?? 0)
        );
      }
      if (lowlink.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        for (;;) {
          const member = stack.pop();
          if (member === undefined) {
            break;
          }
          onStack.delete(member);
          component.push(member);
          if (member === frame.node) {
            break;
          }
        }
        components.push(component);
      }
    }
  }

  return components;
}
