import { describe, it, expect } from "vitest";
import {
  buildDownloadTree,
  folderSelectionState,
  type DownloadTreeFolderNode,
} from "./downloadPanelTree";
import type { PlannedBulkFile } from "./folderDownload";

function planned(
  id: string,
  rootSegments: string[],
  destRelativePath: string[],
  size = 100,
): PlannedBulkFile {
  return {
    file: {
      id,
      name: destRelativePath[destRelativePath.length - 1] ?? id,
      mimeType: "audio/mpeg",
      size,
      relativeDir: destRelativePath.slice(0, -1),
      destName: destRelativePath[destRelativePath.length - 1] ?? id,
      destRelativePath,
    },
    rootSegments,
  };
}

describe("buildDownloadTree", () => {
  it("groups folder files under their root and loose files at the top level", () => {
    const tree = buildDownloadTree([
      planned("f1", ["Album"], ["a.mp3"]),
      planned("f2", ["Album"], ["Sub", "b.mp3"]),
      planned("f3", [], ["loose.mp3"]),
    ]);

    // Album folder + loose file at the top level.
    expect(tree).toHaveLength(2);
    const album = tree[0] as DownloadTreeFolderNode;
    expect(album.kind).toBe("folder");
    expect(album.name).toBe("Album");
    expect(album.fileIndices).toEqual([0, 1]);
    expect(tree[1]?.kind).toBe("file");
    // a.mp3 directly under Album, Sub nested with b.mp3 inside.
    expect(album.children[0]?.kind).toBe("file");
    const sub = album.children[1] as DownloadTreeFolderNode;
    expect(sub.kind).toBe("folder");
    expect(sub.name).toBe("Sub");
    expect(sub.fileIndices).toEqual([1]);
    expect(sub.children).toHaveLength(1);
    expect(sub.children[0]?.kind).toBe("file");
  });

  it("counts a folder by its files, never by folders: 12-file folder + 2 loose = 14", () => {
    const files = [
      ...Array.from({ length: 12 }, (_, i) =>
        planned(`f${String(i)}`, ["Big"], [`song${String(i)}.mp3`]),
      ),
      planned("loose1", [], ["a.mp3"]),
      planned("loose2", [], ["b.mp3"]),
    ];
    const tree = buildDownloadTree(files);

    const folder = tree.find(
      (n): n is DownloadTreeFolderNode => n.kind === "folder",
    );
    expect(folder?.fileIndices).toHaveLength(12);
    // The panel's count is the plan length (files only), not nodes.
    expect(files).toHaveLength(14);
  });

  it("returns no folder node for a folder with no downloadable files", () => {
    expect(buildDownloadTree([])).toEqual([]);
  });

  it("keeps file indices stable for the panel's tick set", () => {
    const tree = buildDownloadTree([
      planned("f1", ["A"], ["x.mp3"]),
      planned("f2", ["A"], ["y.mp3"]),
      planned("f3", ["B"], ["z.mp3"]),
    ]);

    const a = tree[0] as DownloadTreeFolderNode;
    const b = tree[1] as DownloadTreeFolderNode;
    expect(a.fileIndices).toEqual([0, 1]);
    expect(b.fileIndices).toEqual([2]);
  });
});

describe("folderSelectionState", () => {
  it("reports all / none / some from the ticked set", () => {
    expect(folderSelectionState([0, 1, 2], new Set([0, 1, 2]))).toBe("all");
    expect(folderSelectionState([0, 1, 2], new Set())).toBe("none");
    expect(folderSelectionState([0, 1, 2], new Set([1]))).toBe("some");
    expect(folderSelectionState([], new Set([1]))).toBe("none");
  });
});
