import { createFolder } from "../driveApi";
import type { DriveFileItem } from "../driveApi";
import { registerUploadPath, walkDiskFolder } from "../diskFs";
import type { DiskEntry } from "../diskFs";
import { basename } from "../pathUtils";
import { controllerFor } from "./controllers";
import {
  PENDING_ID_PREFIX,
  ParentFolderMissingError,
  requireDiskPath,
} from "./errors";
import { abortIfCancelled, abortedUploadError } from "./retry";
import type { FolderBatch, InternalEntry } from "./types";

function dirOf(relPath: string): string {
  const idx = relPath.lastIndexOf("/");
  return idx === -1 ? "" : relPath.slice(0, idx);
}

export async function handleFolderChild(
  entry: InternalEntry,
): Promise<DriveFileItem> {
  // A subfolder's parent is the dir ABOVE it ('sub' -> batch root;
  // 'sub/sub2' -> 'sub'), resolved via the batch memo.
  const parentDir = dirOf(entry.relativeDir ?? "");
  const parentId = entry.batchMemo?.get(parentDir);
  if (!parentId) throw new ParentFolderMissingError(parentDir);
  entry.parentId = parentId;
  // Cancel must abort the in-flight createFolder (driveApi forwards the
  // signal into driveFetch); the rejection is normalized so a cancel of a
  // subfolder surfaces as 'aborted', not 'failed' + error toast.
  const signal = controllerFor(entry)?.signal;
  return abortIfCancelled(
    createFolder(entry.token, entry.name, entry.parentId, signal),
    signal,
  );
}

// Folder roots walk their whole subtree and enqueue one child entry per
// file/subfolder. PURE by contract: children are NOT pushed into the queue
// here — each built entry is handed to the `enqueue` callback so queue.ts
// stays the single owner of the live entries array (folderBatch never touches
// it). The batch memo (shared by reference across every child) is built here
// and threaded through the returned entries unchanged.
export async function handleFolderRoot(
  entry: InternalEntry,
  enqueue: (child: InternalEntry) => void,
): Promise<DriveFileItem> {
  const dirPath = requireDiskPath(entry);
  await registerUploadPath(dirPath);
  // The batch's cancel controller must reach BOTH the walk and the folder
  // creation: without it a cancel of the root folder would still walk + create
  // + enqueue every child, and the children would upload despite the cancel.
  const signal = controllerFor(entry)?.signal;
  const walked = await abortIfCancelled(
    walkDiskFolder(dirPath, signal),
    signal,
  );
  const rootFolder = await abortIfCancelled(
    createFolder(entry.token, entry.name, entry.parentId, signal),
    signal,
  );
  const memo = new Map<string, string>();
  memo.set("", rootFolder.id);
  const batch: FolderBatch = { entry, memo };
  // A cancel that landed while createFolder was resolving must not enqueue the
  // walked children — they would upload after the user already cancelled.
  if (signal?.aborted) throw abortedUploadError();
  // walkDiskFolder sorts by relativePath, so a folder's entry (and thus its
  // creation) always precedes the files inside it - the sequential queue
  // preserves that order and the memo is filled before children resolve it.
  for (const item of walked) {
    if (item.isDirectory) {
      if (!memo.has(item.relativePath))
        enqueue(makeFolderChild(batch, item.relativePath));
    } else {
      ensureSubfolderChain(batch, item.relativePath, enqueue);
      enqueue(makeChildFile(batch, item));
    }
  }
  return rootFolder;
}

// One folder entry per distinct subfolder (memo dedupes), even if walk omits dirs.
function ensureSubfolderChain(
  batch: FolderBatch,
  relPath: string,
  enqueue: (child: InternalEntry) => void,
): void {
  const dir = dirOf(relPath);
  if (!dir) return;
  let acc = "";
  for (const segment of dir.split("/")) {
    acc = acc ? `${acc}/${segment}` : segment;
    if (!batch.memo.has(acc)) {
      enqueue(makeFolderChild(batch, acc));
    }
  }
}

function makeFolderChild(
  batch: FolderBatch,
  relativeDir: string,
): InternalEntry {
  const entry: InternalEntry = {
    id: `${PENDING_ID_PREFIX}${crypto.randomUUID()}`,
    name: basename(relativeDir),
    isFolder: true,
    parentId: batch.entry.parentId, // placeholder - resolved during processing
    status: "queued",
    token: batch.entry.token,
    kind: "folderChild",
    relativeDir,
    batchMemo: batch.memo,
  };
  batch.memo.set(relativeDir, ""); // '' marker = enqueued, drive id pending
  return entry;
}
function makeChildFile(batch: FolderBatch, item: DiskEntry): InternalEntry {
  return {
    id: `${PENDING_ID_PREFIX}${crypto.randomUUID()}`,
    name: basename(item.relativePath),
    isFolder: false,
    parentId: batch.entry.parentId, // placeholder - resolved during processing
    diskPath: item.path,
    status: "queued",
    token: batch.entry.token,
    kind: "folderChildFile",
    relativeDir: dirOf(item.relativePath),
    batchMemo: batch.memo,
  };
}
