import type { PlannedBulkFile } from "./folderDownload";

/**
 * The DownloadPanel's tree view, built from a flat download plan.
 * Folders are counted by the FILES inside them — never by the number of
 * folders (a folder with 12 files + 2 loose files is 14 files, not 3
 * items). Loose files (no root folder) sit at the top level.
 */

export interface DownloadTreeFileNode {
  kind: "file";
  /** Stable key: the full destination path, e.g. `Album/Sub/song.mp3`. */
  key: string;
  name: string;
  /** Index into the plan's `files` array. */
  fileIndex: number;
}

export interface DownloadTreeFolderNode {
  kind: "folder";
  /** Stable key: the folder's path from the plan root, e.g. `Album/Sub`. */
  key: string;
  name: string;
  children: DownloadTreeNode[];
  /** Every file index under this folder, at any depth (what the folder
   * checkbox ticks/unticks). */
  fileIndices: number[];
}

export type DownloadTreeNode = DownloadTreeFileNode | DownloadTreeFolderNode;

function folderNode(key: string, name: string): DownloadTreeFolderNode {
  return { kind: "folder", key, name, children: [], fileIndices: [] };
}

function childFolder(
  parent: DownloadTreeFolderNode,
  key: string,
  name: string,
): DownloadTreeFolderNode {
  const existing = parent.children.find(
    (c): c is DownloadTreeFolderNode => c.kind === "folder" && c.key === key,
  );
  if (existing) return existing;
  const node = folderNode(key, name);
  parent.children.push(node);
  return node;
}

/**
 * Groups `plan.files` into a tree: one top-level folder per selected
 * folder (`rootSegments`), loose files at the top level, subfolders from
 * `destRelativePath` (all segments but the last, which is the file name).
 * A folder with no downloadable files has no files to show, so it never
 * appears — it is still created on disk by the job itself.
 */
export function buildDownloadTree(
  files: PlannedBulkFile[],
): DownloadTreeNode[] {
  const roots: DownloadTreeNode[] = [];
  const rootFolders = new Map<string, DownloadTreeFolderNode>();

  const topFolder = (rootName: string): DownloadTreeFolderNode => {
    const existing = rootFolders.get(rootName);
    if (existing) return existing;
    const node = folderNode(rootName, rootName);
    rootFolders.set(rootName, node);
    roots.push(node);
    return node;
  };

  files.forEach((planned, fileIndex) => {
    const { file, rootSegments } = planned;
    const dirSegments = file.destRelativePath.slice(0, -1);
    const fileName =
      file.destRelativePath[file.destRelativePath.length - 1] ?? file.destName;
    const fileNode: DownloadTreeFileNode = {
      kind: "file",
      key: [...rootSegments, ...file.destRelativePath].join("/"),
      name: fileName,
      fileIndex,
    };

    if (rootSegments.length === 0) {
      // Loose file: straight into the download dir, top level.
      roots.push(fileNode);
      return;
    }

    let folder = topFolder(rootSegments[0] ?? "");
    folder.fileIndices.push(fileIndex);
    let key = rootSegments[0] ?? "";
    for (const segment of dirSegments) {
      key = `${key}/${segment}`;
      folder = childFolder(folder, key, segment);
      folder.fileIndices.push(fileIndex);
    }
    folder.children.push(fileNode);
  });

  return roots;
}

/** Checkbox state of a folder given the ticked file indices. */
export function folderSelectionState(
  fileIndices: number[],
  selected: ReadonlySet<number>,
): "all" | "none" | "some" {
  if (fileIndices.length === 0) return "none";
  let count = 0;
  for (const i of fileIndices) {
    if (selected.has(i)) count++;
  }
  if (count === 0) return "none";
  if (count === fileIndices.length) return "all";
  return "some";
}
