import { FOLDER_MIME, type DriveFileItem } from "./driveTypes";
import { isPlayableMediaFile } from "./mediaKind";
import { sanitizeFilename } from "./sanitizeFilename";
import { fetchDriveFileById, listFolderAllEntries } from "./drivePagination";
import type { DriveItem } from "../types";
import {
  fetchMetadataBestEffort,
  type DownloadErrorKind,
  type DriveFileMetadata,
} from "./fileDownload";

// Folder download (Step 2): walk a Drive folder tree and download every
// file in it with the Step 1 Rust streamer, preserving the tree structure
// on disk. Drive has NO folder-download endpoint and no server-side ZIP,
// so the scan below is the whole "folder" half: it turns a folder id into a
// flat list of files that each remember their relative directory.
//
// Safety caps mirror collectFolderTracks (1000 files / 1000 folders): one
// Drive listing costs quota per folder, and one download job must stay
// bounded. Hitting a cap stops the walk and reports `truncated` so the
// confirm dialog can tell the user the folder was NOT fully scanned.

export const SHORTCUT_MIME = "application/vnd.google-apps.shortcut";

/** Google Docs/Sheets/Slides (+ Drawing/Form): no binary to fetch with
 * `alt=media`, and Step 2 deliberately does NOT export them — they are
 * skipped and listed in the final report instead of producing junk files. */
export const NATIVE_DOC_MIMES = new Set([
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.spreadsheet",
  "application/vnd.google-apps.presentation",
  "application/vnd.google-apps.drawing",
  "application/vnd.google-apps.form",
]);

export const MAX_FOLDER_DOWNLOAD_FILES = 1000;
export const MAX_FOLDER_DOWNLOAD_FOLDERS = 1000;
/** ~4 parallel files: enough to saturate a home link without tripling the
 * Drive quota burn or the number of half-written `.part` files. */
export const FOLDER_DOWNLOAD_CONCURRENCY = 4;

export type FolderDownloadSkipReason =
  | "native_doc"
  | "no_download_permission"
  | "shortcut_unresolved"
  | "shortcut_cycle";

export interface FolderDownloadSkippedItem {
  /** Display name on Drive (shortcut name for a shortcut). */
  name: string;
  /** Path inside the downloaded folder, e.g. `Sub/Doc.gdoc`. */
  relativePath: string;
  reason: FolderDownloadSkipReason;
}

export interface FolderDownloadFileInput {
  id: string;
  name: string;
  mimeType: string;
  size?: number | undefined;
  md5Checksum?: string | undefined;
  /** Raw Drive folder segments from the root, e.g. `["Sub", "Deep"]`. */
  relativeDir: string[];
}

/** One downloadable file, with its final on-disk name already decided:
 * every path segment is sanitized and names are de-duplicated per
 * directory (Drive allows several files with the same name in one folder;
 * the local filesystem does not). */
export interface FolderDownloadFile extends FolderDownloadFileInput {
  /** Sanitized file name, unique inside its directory. */
  destName: string;
  /** Sanitized relative path incl. the file name, e.g. `["Sub", "a (1).mp3"]`. */
  destRelativePath: string[];
}

export interface FolderDownloadScan {
  rootName: string;
  files: FolderDownloadFile[];
  skipped: FolderDownloadSkippedItem[];
  /** True when a safety cap stopped the walk early: the file list is
   * incomplete and the dialog must say so. */
  truncated: boolean;
  totalBytes: number;
  totalFiles: number;
}

export interface ScanFolderTreeOptions {
  /** When true, only playable media files are collected; everything else
   * is silently excluded (a filter choice, not a skip to report). */
  mediaOnly?: boolean;
  maxFiles?: number;
  maxFolders?: number;
  signal?: AbortSignal;
  /** Injectable for tests: defaults list real Drive children. */
  listEntries?: (
    token: string,
    folderId: string,
    signal?: AbortSignal,
  ) => Promise<DriveFileItem[]>;
  /** Injectable for tests: defaults to a real files.get. */
  fetchTarget?: (
    token: string,
    fileId: string,
    signal?: AbortSignal,
  ) => Promise<DriveFileItem>;
}

interface PendingFolder {
  id: string;
  name: string;
  /** Raw Drive segments from the root to THIS folder (root itself: []). */
  relativeDir: string[];
}

function toSize(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const size = parseInt(raw, 10);
  return Number.isFinite(size) ? size : undefined;
}

function joinRelativePath(segments: string[], name: string): string {
  return [...segments, name].join("/");
}

/**
 * Breadth-first walk of a Drive folder tree (iterative FIFO queue, so a
 * deep tree cannot overflow the call stack). Shortcuts are resolved to
 * their target: a folder target is walked under the shortcut's display
 * name, a file target downloads under the shortcut's name. Unresolvable
 * shortcuts, cycles, native Docs and non-downloadable files are skipped
 * and recorded in `skipped` — never downloaded as junk, never fatal.
 * Listing errors and aborts propagate to the caller (a failed scan is a
 * failed job, not a partial download).
 */
export async function scanFolderTree(
  token: string,
  rootFolderId: string,
  rootFolderName: string,
  options: ScanFolderTreeOptions = {},
): Promise<FolderDownloadScan> {
  const {
    mediaOnly = false,
    maxFiles = MAX_FOLDER_DOWNLOAD_FILES,
    maxFolders = MAX_FOLDER_DOWNLOAD_FOLDERS,
    signal,
    listEntries = listFolderAllEntries,
    fetchTarget = fetchDriveFileById,
  } = options;

  const inputs: FolderDownloadFileInput[] = [];
  const skipped: FolderDownloadSkippedItem[] = [];
  // Child folder names per directory (sanitized later): a file whose
  // sanitized name equals a sibling folder name must be de-duplicated too,
  // or the Rust rename would land on top of a directory.
  const folderNamesByDir = new Map<string, Set<string>>();
  const pending: PendingFolder[] = [
    { id: rootFolderId, name: rootFolderName, relativeDir: [] },
  ];
  const visited = new Set<string>([rootFolderId]);
  let foldersWalked = 0;
  let truncated = false;

  const noteFolderName = (dir: string[], name: string): void => {
    const key = JSON.stringify(dir);
    let set = folderNamesByDir.get(key);
    if (!set) {
      set = new Set<string>();
      folderNamesByDir.set(key, set);
    }
    set.add(name);
  };

  while (pending.length > 0) {
    signal?.throwIfAborted();
    if (foldersWalked >= maxFolders) {
      truncated = true;
      break;
    }
    const folder = pending.shift();
    if (folder === undefined) break;
    foldersWalked++;

    const entries = await listEntries(token, folder.id, signal);
    signal?.throwIfAborted();

    for (const entry of entries) {
      if (entry.mimeType === FOLDER_MIME) {
        if (visited.has(entry.id)) continue;
        visited.add(entry.id);
        noteFolderName(folder.relativeDir, entry.name);
        pending.push({
          id: entry.id,
          name: entry.name,
          relativeDir: [...folder.relativeDir, entry.name],
        });
        continue;
      }

      if (entry.mimeType === SHORTCUT_MIME) {
        const targetId = entry.shortcutDetails?.targetId;
        const relPath = joinRelativePath(folder.relativeDir, entry.name);
        if (!targetId) {
          skipped.push({
            name: entry.name,
            relativePath: relPath,
            reason: "shortcut_unresolved",
          });
          continue;
        }
        if (visited.has(targetId)) {
          skipped.push({
            name: entry.name,
            relativePath: relPath,
            reason: "shortcut_cycle",
          });
          continue;
        }
        let target: DriveFileItem;
        try {
          target = await fetchTarget(token, targetId, signal);
        } catch {
          skipped.push({
            name: entry.name,
            relativePath: relPath,
            reason: "shortcut_unresolved",
          });
          continue;
        }
        if (target.mimeType === FOLDER_MIME) {
          visited.add(targetId);
          noteFolderName(folder.relativeDir, entry.name);
          pending.push({
            id: targetId,
            name: entry.name,
            relativeDir: [...folder.relativeDir, entry.name],
          });
          continue;
        }
        if (NATIVE_DOC_MIMES.has(target.mimeType)) {
          skipped.push({
            name: entry.name,
            relativePath: relPath,
            reason: "native_doc",
          });
          continue;
        }
        if (target.capabilities?.canDownload === false) {
          skipped.push({
            name: entry.name,
            relativePath: relPath,
            reason: "no_download_permission",
          });
          continue;
        }
        if (mediaOnly && !isPlayableMediaFile(entry.name)) continue;
        inputs.push({
          id: targetId,
          name: entry.name,
          mimeType: target.mimeType,
          size: toSize(target.size),
          md5Checksum: target.md5Checksum,
          relativeDir: folder.relativeDir,
        });
        if (inputs.length >= maxFiles) {
          truncated = true;
          break;
        }
        continue;
      }

      if (NATIVE_DOC_MIMES.has(entry.mimeType)) {
        skipped.push({
          name: entry.name,
          relativePath: joinRelativePath(folder.relativeDir, entry.name),
          reason: "native_doc",
        });
        continue;
      }
      if (entry.capabilities?.canDownload === false) {
        skipped.push({
          name: entry.name,
          relativePath: joinRelativePath(folder.relativeDir, entry.name),
          reason: "no_download_permission",
        });
        continue;
      }
      if (mediaOnly && !isPlayableMediaFile(entry.name)) continue;

      inputs.push({
        id: entry.id,
        name: entry.name,
        mimeType: entry.mimeType,
        size: toSize(entry.size),
        md5Checksum: entry.md5Checksum,
        relativeDir: folder.relativeDir,
      });
      if (inputs.length >= maxFiles) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }

  const files = assignDestNames(inputs, folderNamesByDir);
  return {
    rootName: rootFolderName,
    files,
    skipped,
    truncated,
    totalBytes: files.reduce((sum, f) => sum + (f.size ?? 0), 0),
    totalFiles: files.length,
  };
}

/**
 * Decide final on-disk names: sanitize every path segment (Windows rules)
 * and de-duplicate within each directory with a ` (1)`, ` (2)` suffix
 * before the extension. `folderNamesByDir` holds RAW folder names per
 * directory (keyed by JSON of the raw relative dir); a file colliding with
 * a sibling folder name is suffixed the same way.
 */
export function assignDestNames(
  inputs: FolderDownloadFileInput[],
  folderNamesByDir: Map<string, Set<string>> = new Map(),
): FolderDownloadFile[] {
  const usedByDir = new Map<string, Set<string>>();
  // Seed each directory's used set with its sanitized subfolder names so
  // no file can take a folder's name.
  for (const [key, names] of folderNamesByDir) {
    usedByDir.set(key, new Set([...names].map((n) => sanitizeFilename(n))));
  }

  return inputs.map((input) => {
    const sanitizedDir = input.relativeDir.map((segment) =>
      sanitizeFilename(segment),
    );
    const dirKey = JSON.stringify(input.relativeDir);
    let used = usedByDir.get(dirKey);
    if (!used) {
      used = new Set<string>();
      usedByDir.set(dirKey, used);
    }
    const base = sanitizeFilename(input.name);
    let destName = base;
    if (used.has(destName)) {
      const dot = base.lastIndexOf(".");
      const stem = dot > 0 ? base.slice(0, dot) : base;
      const ext = dot > 0 ? base.slice(dot) : "";
      let n = 1;
      do {
        destName = `${stem} (${String(n)})${ext}`;
        n++;
      } while (used.has(destName));
    }
    used.add(destName);
    return {
      ...input,
      destName,
      destRelativePath: [...sanitizedDir, destName],
    };
  });
}

export interface FolderFileProgressInput {
  downloaded: number;
  total?: number | undefined;
  done: boolean;
}

export interface FolderProgress {
  completed: number;
  total: number;
  downloadedBytes: number;
  /** Sum of KNOWN totals only; undefined totals contribute 0. */
  totalBytes: number;
  percent?: number | undefined;
}

/** Aggregate per-file progress into the folder-level bar. `percent` is
 * undefined while no file has reported a total yet (never a fake 0%). */
export function computeFolderProgress(
  states: FolderFileProgressInput[],
): FolderProgress {
  let completed = 0;
  let downloadedBytes = 0;
  let totalBytes = 0;
  for (const s of states) {
    if (s.done) completed++;
    downloadedBytes += s.downloaded;
    totalBytes += s.total ?? 0;
  }
  return {
    completed,
    total: states.length,
    downloadedBytes,
    totalBytes,
    percent:
      totalBytes > 0
        ? Math.min(100, Math.floor((downloadedBytes * 100) / totalBytes))
        : undefined,
  };
}

/**
 * Whether one file's failure kind must stop the WHOLE folder job instead
 * of being recorded as a per-file failure and skipped: an unrefreshable
 * sign-in, a destination that cannot be written, or a full disk. Every
 * other kind (network, timeout, rate limit, not found, checksum, size…)
 * fails only that file — the queue keeps going and the summary lists it
 * for retry.
 */
export function isFolderDownloadFatalKind(kind: DownloadErrorKind): boolean {
  return kind === "unauthorized" || kind === "no_space" || kind === "save";
}

// ---------------------------------------------------------------------------
// Selection-driven bulk download: "download exactly what is selected"
// ---------------------------------------------------------------------------

/** One file to download, with its root already decided: `[]` for a loose
 * selected file (straight into the download dir), `[folderName]` for a
 * file inside a selected folder. `file.destRelativePath` is relative to
 * that root. */
export interface PlannedBulkFile {
  file: FolderDownloadFile;
  rootSegments: string[];
}

/** A selected loose file that cannot be downloaded at all (gone from
 * Drive). It counts as a failed file in the final summary — it is never
 * silently dropped. */
export interface BulkDownloadUnavailableItem {
  name: string;
  kind: DownloadErrorKind;
}

export interface BulkDownloadPlan {
  files: PlannedBulkFile[];
  skipped: FolderDownloadSkippedItem[];
  unavailable: BulkDownloadUnavailableItem[];
  /** Sanitized, de-duplicated root folder names, in selection order —
   * created even when every file inside was skipped, so the user still
   * sees the (empty) folder. */
  roots: string[];
  truncated: boolean;
  totalBytes: number;
  totalFiles: number;
}

export interface ExpandSelectionOptions {
  signal?: AbortSignal;
  /** Injectable for tests: defaults to the real `scanFolderTree`. */
  scanFolder?: (
    token: string,
    folderId: string,
    folderName: string,
    options?: ScanFolderTreeOptions,
  ) => Promise<FolderDownloadScan>;
  /** Injectable for tests: defaults to the real best-effort metadata read. */
  fetchMetadata?: (
    fileId: string,
    signal?: AbortSignal,
  ) => Promise<{ metadata: DriveFileMetadata; fileGone: boolean }>;
}

function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  let n = 1;
  let candidate = `${stem} (${String(n)})${ext}`;
  while (used.has(candidate)) {
    n++;
    candidate = `${stem} (${String(n)})${ext}`;
  }
  used.add(candidate);
  return candidate;
}

/**
 * Turns the user's current selection into a flat download plan — no UI of
 * its own, it only reads Drive. Folders are scanned with `scanFolderTree`
 * (tree preserved under a de-duplicated root name); loose files are kept
 * by their Drive name (sanitized, de-duplicated against the root folder
 * names and each other). Native Docs and non-downloadable loose files are
 * skipped and recorded, gone files are reported as unavailable — never
 * downloaded as junk, never fatal. There is deliberately NO media-only
 * filter here: the selection flow has no place to choose one, so it
 * downloads exactly what was selected.
 */
export async function expandSelectionToPlan(
  items: DriveItem[],
  token: string,
  options: ExpandSelectionOptions = {},
): Promise<BulkDownloadPlan> {
  const {
    signal,
    scanFolder = scanFolderTree,
    fetchMetadata = fetchMetadataBestEffort,
  } = options;

  const usedRoots = new Set<string>();
  const roots: string[] = [];
  const files: PlannedBulkFile[] = [];
  const skipped: FolderDownloadSkippedItem[] = [];
  const unavailable: BulkDownloadUnavailableItem[] = [];
  const looseInputs: FolderDownloadFileInput[] = [];
  let truncated = false;

  for (const item of items) {
    signal?.throwIfAborted();
    if (item.isFolder) {
      const rootName = uniqueName(sanitizeFilename(item.title), usedRoots);
      roots.push(rootName);
      const scan = await scanFolder(token, item.id, item.title, {
        ...(signal ? { signal } : {}),
      });
      truncated = truncated || scan.truncated;
      skipped.push(...scan.skipped);
      for (const file of scan.files) {
        files.push({ file, rootSegments: [rootName] });
      }
      continue;
    }
    const { metadata, fileGone } = await fetchMetadata(item.id, signal);
    if (fileGone) {
      unavailable.push({ name: item.title, kind: "not_found" });
      continue;
    }
    if (
      metadata.mimeType !== undefined &&
      NATIVE_DOC_MIMES.has(metadata.mimeType)
    ) {
      skipped.push({
        name: item.title,
        relativePath: item.title,
        reason: "native_doc",
      });
      continue;
    }
    if (metadata.canDownload === false) {
      skipped.push({
        name: item.title,
        relativePath: item.title,
        reason: "no_download_permission",
      });
      continue;
    }
    looseInputs.push({
      id: item.id,
      name: item.title,
      mimeType: metadata.mimeType ?? "",
      size: metadata.size,
      md5Checksum: metadata.md5Checksum,
      relativeDir: [],
    });
  }

  // Loose files land straight in the download dir: seed their directory
  // with the (already de-duplicated) root folder names so no loose file
  // can take a folder's name.
  const folderNamesByDir = new Map<string, Set<string>>([
    [JSON.stringify([]), new Set(roots)],
  ]);
  for (const file of assignDestNames(looseInputs, folderNamesByDir)) {
    files.push({ file, rootSegments: [] });
  }

  return {
    files,
    skipped,
    unavailable,
    roots,
    truncated,
    totalBytes: files.reduce((sum, f) => sum + (f.file.size ?? 0), 0),
    totalFiles: files.length,
  };
}
