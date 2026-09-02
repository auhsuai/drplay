import { bindEntries } from "./events";
import type { InternalEntry } from "./types";

// Single owner of the live queue array and its scan invariants. Other upload
// modules touch entries only through the accessors here, queue.ts stays a
// thin public facade, and the import graph stays acyclic
// (state -> events, never events -> queue).

let entries: InternalEntry[] = [];
// Monotonic scan head for pump: the first queued entry is searched from here
// instead of from index 0 on every iteration (a batch of N uploads was
// O(n²) — ~3N² array ops at N=5000). Invariants that keep it correct:
// 1) every enqueue path (startUploads, resumeInterruptedUploads, folder
//    children) appends at the TAIL, i.e. at index >= nextScanIndex;
// 2) nothing before the head ever returns to 'queued' (processEntry flips to
//    'uploading' synchronously, terminal entries are pruned);
// 3) pruneEntry pulls the head back by one when it removes an entry AHEAD of
//    it, because the filter copy shifts every later index left by one.
let nextScanIndex = 0;

// events.ts (notify/getEntries/getUploadState) must READ the live entries but
// never own/mutate them — hand it a read-only getter so the import graph stays
// acyclic (queue -> events, never events -> queue).
bindEntries(() => entries);

// Append entries at the TAIL — the invariant nextScanIndex relies on (see its
// comment above). Every enqueue path funnels here.
export function appendEntries(...added: InternalEntry[]): void {
  entries.push(...added);
}

// Read-only view for cross-module scans (resume's live-entry checks). The
// array itself stays owned and mutated by this module.
export function readEntries(): readonly InternalEntry[] {
  return entries;
}

// P2-B4 duplicate-seed guard: does a live entry with the same
// (diskPath, parentId) still sit in queued/uploading? Only disk-path seeds
// carry the stable identity this check needs (bytes seeds have no key).
export function hasActiveDuplicate(
  diskPath: string,
  parentId: string,
): boolean {
  return entries.some(
    (e) =>
      e.diskPath === diskPath &&
      e.parentId === parentId &&
      (e.status === "queued" || e.status === "uploading"),
  );
}

// An entry is reachable by its pending id ('pending-…') or, once known, by its
// Drive id — callers may hold either. Shared lookup for cancelUpload and
// getUploadProgress.
export function findEntryByAnyId(id: string): InternalEntry | undefined {
  return entries.find((e) => e.id === id || e.driveId === id);
}

// A folder-child FILE cannot start before its parent folder's Drive id is
// known: handleChildFile throws ParentFolderMissingError on the '' memo
// marker. The parent (a folderChild entry) is always enqueued before its
// children (walk order), so a child whose memo is still '' is blocked while
// the parent is queued/uploading — once the parent settles (done → memo set,
// or cancelled/errored → gone from the queue) the child is claimable again
// and either uploads or fails with parent-folder-missing like the sequential
// queue did.
function childParentResolved(entry: InternalEntry): boolean {
  if (entry.kind !== "folderChildFile" || entry.batchMemo === undefined) {
    return true;
  }
  const dir = entry.relativeDir ?? "";
  if (entry.batchMemo.get(dir)) return true;
  return !entries.some(
    (e) =>
      e.batchMemo === entry.batchMemo &&
      e.kind === "folderChild" &&
      e.relativeDir === dir &&
      (e.status === "queued" || e.status === "uploading"),
  );
}

// First CLAIMABLE entry with status 'queued', scanned from the monotonic head —
// FIFO by array order, identical selection to the old entries.find from index 0,
// but each entry is visited at most once per pass (entries at index < head
// are settled by invariant — see the nextScanIndex comment). When the scan
// runs out, the head resets to the tail so the next pump pass starts fresh.
// A blocked child (parent folder still resolving) does NOT advance the head —
// the next scan re-evaluates it, while a claimable entry further along the
// queue is still claimed (a free slot must not stall behind one unresolved
// parent).
export function nextQueued(): InternalEntry | undefined {
  let firstBlocked: number | undefined;
  for (let i = nextScanIndex; i < entries.length; i++) {
    const candidate = entries[i];
    if (candidate === undefined) continue; // noUncheckedIndexedAccess guard — array has no holes
    if (candidate.status !== "queued") continue;
    if (!childParentResolved(candidate)) {
      if (firstBlocked === undefined) firstBlocked = i;
      continue;
    }
    nextScanIndex = firstBlocked ?? i + 1;
    return candidate;
  }
  nextScanIndex = firstBlocked ?? entries.length;
  return undefined;
}

// Terminal (done/error) entries are useless to the UI — getUploadingIds /
// getUploadState only read queued/uploading — but each holds a full diskPath
// string and (for byte seeds) the raw payload, so keeping them is an
// unbounded retention that grows with every batch. Callers must have fired
// their final notify() first so subscribers still observe the terminal state.
export function pruneEntry(entry: InternalEntry): void {
  entry.bytes = undefined;
  const removedIndex = entries.indexOf(entry);
  entries = entries.filter((e) => e !== entry);
  // The filter copy shifts every index after the removed one left by one, so
  // a removal AHEAD of the scan head must pull the head back to keep pointing
  // at the same logical position (removals behind it leave it untouched).
  if (removedIndex !== -1 && removedIndex < nextScanIndex) {
    nextScanIndex -= 1;
  }
}
