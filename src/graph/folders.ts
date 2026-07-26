import type { GraphEdge, GraphNode } from '../scanner/model';

export const ROOT_FOLDER = '(root)';

export interface FolderGroup {
  id: string;
  key: string;
  name: string;
  files: GraphNode[];
}

export interface AggregatedFolderEdge {
  from: string;
  to: string;
  count: number;
}

export function folderKeyForPath(filePath: string): string {
  const normalizedPath = filePath.replaceAll('\\', '/').replace(/^\.\/+/, '');
  const separator = normalizedPath.indexOf('/');
  return separator < 0 ? ROOT_FOLDER : normalizedPath.slice(0, separator);
}

export function groupFilesByFolder(nodes: readonly GraphNode[]): FolderGroup[] {
  const groups = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    if (node.kind !== 'file') {
      continue;
    }
    const key = folderKeyForPath(node.path);
    const files = groups.get(key);
    if (files === undefined) {
      groups.set(key, [node]);
    } else {
      files.push(node);
    }
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, files]) => ({
      id: folderId(key),
      key,
      name: key,
      files: files.sort((left, right) => left.path.localeCompare(right.path))
    }));
}

export function mapFilesToFolders(
  groups: readonly FolderGroup[]
): Map<string, string> {
  const mapping = new Map<string, string>();
  for (const group of groups) {
    for (const file of group.files) {
      mapping.set(file.id, group.id);
    }
  }
  return mapping;
}

export function aggregateFolderEdges(
  edges: readonly GraphEdge[],
  folderByFileId: ReadonlyMap<string, string>
): AggregatedFolderEdge[] {
  const counts = new Map<string, AggregatedFolderEdge>();
  for (const edge of edges) {
    if (edge.kind !== 'import') {
      continue;
    }
    const sourceFolder = folderByFileId.get(edge.from);
    const targetFolder = folderByFileId.get(edge.to);
    if (
      sourceFolder === undefined
      || targetFolder === undefined
      || sourceFolder === targetFolder
    ) {
      continue;
    }
    const key = `${sourceFolder}\0${targetFolder}`;
    const existing = counts.get(key);
    if (existing === undefined) {
      counts.set(key, { from: sourceFolder, to: targetFolder, count: 1 });
    } else {
      existing.count += 1;
    }
  }
  return [...counts.values()].sort((left, right) =>
    `${left.from}\0${left.to}`.localeCompare(`${right.from}\0${right.to}`)
  );
}

export function folderId(key: string): string {
  return `folder:${key}`;
}
