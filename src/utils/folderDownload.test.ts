import { describe, expect, it } from "vitest";
import type { DriveFileItem } from "./driveTypes";
import type { DriveItem } from "../types";
import {
  assignDestNames,
  computeFolderProgress,
  expandSelectionToPlan,
  isFolderDownloadFatalKind,
  scanFolderTree,
  type FolderDownloadFileInput,
  type FolderDownloadScan,
} from "./folderDownload";

const FOLDER = "application/vnd.google-apps.folder";
const SHORTCUT = "application/vnd.google-apps.shortcut";
const DOC = "application/vnd.google-apps.document";

function item(
  overrides: Partial<DriveFileItem> & { id: string; name: string },
): DriveFileItem {
  return { mimeType: "audio/mpeg", ...overrides };
}

describe("scanFolderTree", () => {
  it("returns the tree structure: nested files keep their relativeDir", async () => {
    const listEntries = (
      _token: string,
      folderId: string,
    ): Promise<DriveFileItem[]> =>
      Promise.resolve(
        folderId === "root"
          ? [
              item({ id: "a", name: "song.mp3", size: "100" }),
              item({ id: "sub", name: "Sub", mimeType: FOLDER }),
            ]
          : folderId === "sub"
            ? [
                item({ id: "b", name: "deep.flac", size: "200" }),
                item({ id: "sub2", name: "Deep", mimeType: FOLDER }),
              ]
            : [item({ id: "c", name: "x.mkv", size: "300" })],
      );
    const scan = await scanFolderTree("tok", "root", "Root", { listEntries });
    expect(scan.totalFiles).toBe(3);
    expect(scan.totalBytes).toBe(600);
    expect(scan.truncated).toBe(false);
    expect(scan.files.map((f) => f.destRelativePath.join("/"))).toEqual([
      "song.mp3",
      "Sub/deep.flac",
      "Sub/Deep/x.mkv",
    ]);
  });

  it("mediaOnly keeps only playable media files", async () => {
    const listEntries = (): Promise<DriveFileItem[]> =>
      Promise.resolve([
        item({ id: "a", name: "song.mp3" }),
        item({ id: "b", name: "notes.txt", mimeType: "text/plain" }),
        item({ id: "c", name: "movie.mkv" }),
      ]);
    const scan = await scanFolderTree("tok", "root", "Root", {
      listEntries,
      mediaOnly: true,
    });
    expect(scan.files.map((f) => f.name)).toEqual(["song.mp3", "movie.mkv"]);
    expect(scan.skipped).toEqual([]);
  });

  it("reports truncation when the file cap is hit", async () => {
    const listEntries = (): Promise<DriveFileItem[]> =>
      Promise.resolve([
        item({ id: "a", name: "1.mp3" }),
        item({ id: "b", name: "2.mp3" }),
        item({ id: "c", name: "3.mp3" }),
      ]);
    const scan = await scanFolderTree("tok", "root", "Root", {
      listEntries,
      maxFiles: 2,
    });
    expect(scan.totalFiles).toBe(2);
    expect(scan.truncated).toBe(true);
  });

  it("resolves a shortcut to a folder and walks it under the shortcut name", async () => {
    const listEntries = (
      _token: string,
      folderId: string,
    ): Promise<DriveFileItem[]> =>
      Promise.resolve(
        folderId === "root"
          ? [
              item({
                id: "sc",
                name: "Linked",
                mimeType: SHORTCUT,
                shortcutDetails: { targetId: "real-folder" },
              }),
            ]
          : [item({ id: "f", name: "inside.mp3", size: "50" })],
      );
    const fetchTarget = (): Promise<DriveFileItem> =>
      Promise.resolve(
        item({ id: "real-folder", name: "Real", mimeType: FOLDER }),
      );
    const scan = await scanFolderTree("tok", "root", "Root", {
      listEntries,
      fetchTarget,
    });
    expect(scan.files.map((f) => f.destRelativePath.join("/"))).toEqual([
      "Linked/inside.mp3",
    ]);
    expect(scan.skipped).toEqual([]);
  });

  it("resolves a shortcut to a file under the shortcut name", async () => {
    const listEntries = (): Promise<DriveFileItem[]> =>
      Promise.resolve([
        item({
          id: "sc",
          name: "My Song.mp3",
          mimeType: SHORTCUT,
          shortcutDetails: { targetId: "real-file" },
        }),
      ]);
    const fetchTarget = (): Promise<DriveFileItem> =>
      Promise.resolve(
        item({
          id: "real-file",
          name: "orig.mp3",
          size: "77",
          md5Checksum: "m",
        }),
      );
    const scan = await scanFolderTree("tok", "root", "Root", {
      listEntries,
      fetchTarget,
    });
    expect(scan.files).toHaveLength(1);
    expect(scan.files[0]?.id).toBe("real-file");
    expect(scan.files[0]?.name).toBe("My Song.mp3");
    expect(scan.files[0]?.size).toBe(77);
    expect(scan.files[0]?.md5Checksum).toBe("m");
  });

  it("lists an unresolvable shortcut and a shortcut cycle as skipped, never as files", async () => {
    const listEntries = (): Promise<DriveFileItem[]> =>
      Promise.resolve([
        item({
          id: "sc1",
          name: "Broken",
          mimeType: SHORTCUT,
          shortcutDetails: { targetId: "gone" },
        }),
        item({
          id: "sc2",
          name: "Loop",
          mimeType: SHORTCUT,
          shortcutDetails: { targetId: "root" },
        }),
        item({
          id: "sc3",
          name: "NoTarget",
          mimeType: SHORTCUT,
          shortcutDetails: {},
        }),
      ]);
    const fetchTarget = (): Promise<DriveFileItem> =>
      Promise.reject(new Error("Failed to fetch file gone (404)"));
    const scan = await scanFolderTree("tok", "root", "Root", {
      listEntries,
      fetchTarget,
    });
    expect(scan.files).toEqual([]);
    expect(scan.skipped).toEqual([
      { name: "Broken", relativePath: "Broken", reason: "shortcut_unresolved" },
      { name: "Loop", relativePath: "Loop", reason: "shortcut_cycle" },
      {
        name: "NoTarget",
        relativePath: "NoTarget",
        reason: "shortcut_unresolved",
      },
    ]);
  });

  it("skips native Docs files and non-downloadable files, listing both", async () => {
    const listEntries = (): Promise<DriveFileItem[]> =>
      Promise.resolve([
        item({ id: "d", name: "Doc", mimeType: DOC }),
        item({
          id: "e",
          name: "locked.mp3",
          capabilities: { canDownload: false },
        }),
        item({ id: "f", name: "ok.mp3" }),
      ]);
    const scan = await scanFolderTree("tok", "root", "Root", { listEntries });
    expect(scan.files.map((f) => f.name)).toEqual(["ok.mp3"]);
    expect(scan.skipped).toEqual([
      { name: "Doc", relativePath: "Doc", reason: "native_doc" },
      {
        name: "locked.mp3",
        relativePath: "locked.mp3",
        reason: "no_download_permission",
      },
    ]);
  });
});

describe("assignDestNames", () => {
  const input = (
    name: string,
    relativeDir: string[] = [],
  ): FolderDownloadFileInput => ({
    id: name,
    name,
    mimeType: "audio/mpeg",
    relativeDir,
  });

  it("sanitizes folder segments and file names", () => {
    const [file] = assignDestNames([input("a:b?.mp3", ["My: Folder"])]);
    expect(file?.destRelativePath).toEqual(["My_ Folder", "a_b_.mp3"]);
  });

  it("suffixes duplicate names in the same directory with (1), (2)", () => {
    const files = assignDestNames([
      input("song.mp3"),
      input("song.mp3"),
      input("song.mp3"),
    ]);
    expect(files.map((f) => f.destName)).toEqual([
      "song.mp3",
      "song (1).mp3",
      "song (2).mp3",
    ]);
  });

  it("allows the same name in different directories", () => {
    const files = assignDestNames([
      input("song.mp3"),
      input("song.mp3", ["Sub"]),
    ]);
    expect(files.map((f) => f.destName)).toEqual(["song.mp3", "song.mp3"]);
  });

  it("suffixes a file that collides with a sibling folder name", () => {
    const files = assignDestNames(
      [input("Sub")],
      new Map([["[]", new Set(["Sub"])]]),
    );
    expect(files[0]?.destName).toBe("Sub (1)");
  });

  it("keeps the extension when suffixing an extensionless name", () => {
    const files = assignDestNames([input("README"), input("README")]);
    expect(files.map((f) => f.destName)).toEqual(["README", "README (1)"]);
  });
});

describe("computeFolderProgress", () => {
  it("aggregates completed count, bytes and percent", () => {
    const progress = computeFolderProgress([
      { downloaded: 100, total: 100, done: true },
      { downloaded: 50, total: 200, done: false },
      { downloaded: 0, total: undefined, done: false },
    ]);
    expect(progress).toEqual({
      completed: 1,
      total: 3,
      downloadedBytes: 150,
      totalBytes: 300,
      percent: 50,
    });
  });

  it("has no percent while no total is known", () => {
    expect(
      computeFolderProgress([{ downloaded: 10, done: false }]).percent,
    ).toBeUndefined();
  });
});

describe("isFolderDownloadFatalKind", () => {
  it("treats only token, disk-full and save failures as folder-fatal", () => {
    expect(isFolderDownloadFatalKind("unauthorized")).toBe(true);
    expect(isFolderDownloadFatalKind("no_space")).toBe(true);
    expect(isFolderDownloadFatalKind("save")).toBe(true);
    for (const kind of [
      "network",
      "timeout",
      "not_found",
      "forbidden",
      "rate_limited",
      "checksum",
      "size",
      "cancelled",
      "already_in_progress",
      "unknown",
    ] as const) {
      expect(isFolderDownloadFatalKind(kind)).toBe(false);
    }
  });
});

describe("expandSelectionToPlan", () => {
  const folderScan = (
    files: FolderDownloadScan["files"],
    extra: Partial<FolderDownloadScan> = {},
  ): FolderDownloadScan => ({
    rootName: "Album",
    files,
    skipped: [],
    truncated: false,
    totalBytes: files.reduce((s, f) => s + (f.size ?? 0), 0),
    totalFiles: files.length,
    ...extra,
  });

  const scanFile = (
    id: string,
    name: string,
    size: number,
    destRelativePath: string[],
  ): FolderDownloadScan["files"][number] => ({
    id,
    name,
    mimeType: "audio/mpeg",
    size,
    relativeDir: destRelativePath.slice(0, -1),
    destName: destRelativePath[destRelativePath.length - 1] ?? name,
    destRelativePath,
  });

  const driveItem = (
    overrides: Partial<DriveItem> & { id: string; title: string },
  ): DriveItem => ({ isFolder: false, ...overrides });

  const meta = (
    metadata: import("./fileDownload").DriveFileMetadata,
    fileGone = false,
  ): ((fileId: string) => Promise<{
    metadata: import("./fileDownload").DriveFileMetadata;
    fileGone: boolean;
  }>) => {
    return () => Promise.resolve({ metadata, fileGone });
  };

  it("expands a folder and a loose file into one plan with separate roots", async () => {
    const plan = await expandSelectionToPlan(
      [
        driveItem({ id: "fld", title: "Album", isFolder: true }),
        driveItem({ id: "loose", title: "single.mp3" }),
      ],
      "tok",
      {
        scanFolder: () =>
          Promise.resolve(
            folderScan([scanFile("f1", "a.mp3", 100, ["a.mp3"])]),
          ),
        fetchMetadata: meta({ size: 50, mimeType: "audio/mpeg" }),
      },
    );
    expect(plan.roots).toEqual(["Album"]);
    expect(plan.totalFiles).toBe(2);
    expect(plan.totalBytes).toBe(150);
    expect(plan.truncated).toBe(false);
    expect(
      plan.files.map((f) =>
        [...f.rootSegments, ...f.file.destRelativePath].join("/"),
      ),
    ).toEqual(["Album/a.mp3", "single.mp3"]);
  });

  it("de-duplicates two selected folders with the same name", async () => {
    const plan = await expandSelectionToPlan(
      [
        driveItem({ id: "f1", title: "Album", isFolder: true }),
        driveItem({ id: "f2", title: "Album", isFolder: true }),
      ],
      "tok",
      {
        scanFolder: (_t, folderId) =>
          Promise.resolve(
            folderScan([scanFile(`${folderId}-song`, "a.mp3", 10, ["a.mp3"])]),
          ),
        fetchMetadata: meta({}),
      },
    );
    expect(plan.roots).toEqual(["Album", "Album (1)"]);
    expect(
      plan.files.map((f) =>
        [...f.rootSegments, ...f.file.destRelativePath].join("/"),
      ),
    ).toEqual(["Album/a.mp3", "Album (1)/a.mp3"]);
  });

  it("suffixes a loose file that collides with a selected folder root", async () => {
    const plan = await expandSelectionToPlan(
      [
        driveItem({ id: "fld", title: "Album", isFolder: true }),
        driveItem({ id: "loose", title: "Album" }),
      ],
      "tok",
      {
        scanFolder: () => Promise.resolve(folderScan([])),
        fetchMetadata: meta({ size: 10, mimeType: "text/plain" }),
      },
    );
    expect(plan.roots).toEqual(["Album"]);
    expect(
      plan.files.map((f) =>
        [...f.rootSegments, ...f.file.destRelativePath].join("/"),
      ),
    ).toEqual(["Album (1)"]);
  });

  it("skips a native-Doc loose file and reports a gone file as unavailable", async () => {
    const plan = await expandSelectionToPlan(
      [
        driveItem({ id: "doc", title: "Notes" }),
        driveItem({ id: "gone", title: "old.mp3" }),
        driveItem({ id: "ok", title: "song.mp3" }),
      ],
      "tok",
      {
        fetchMetadata: (fileId) => {
          if (fileId === "doc")
            return Promise.resolve({
              metadata: {
                mimeType: "application/vnd.google-apps.document",
              },
              fileGone: false,
            });
          if (fileId === "gone")
            return Promise.resolve({ metadata: {}, fileGone: true });
          return Promise.resolve({
            metadata: { size: 10, mimeType: "audio/mpeg" },
            fileGone: false,
          });
        },
      },
    );
    expect(plan.files).toHaveLength(1);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]?.reason).toBe("native_doc");
    expect(plan.unavailable).toEqual([{ name: "old.mp3", kind: "not_found" }]);
  });

  it("skips a loose file the account may not download", async () => {
    const plan = await expandSelectionToPlan(
      [driveItem({ id: "x", title: "secret.mp3" })],
      "tok",
      {
        fetchMetadata: meta({
          size: 10,
          mimeType: "audio/mpeg",
          canDownload: false,
        }),
      },
    );
    expect(plan.files).toHaveLength(0);
    expect(plan.skipped[0]?.reason).toBe("no_download_permission");
  });
});
