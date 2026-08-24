import type MiniSearch from "minisearch";
import { db } from "../db/db";
import type { DriveFile, MetadataCacheRow } from "../db/db";
import type { CachedMetadata } from "../utils/metadata";
import { buildSearchIndex, loadRealMetadata, queryIndex } from "./searchEngine";
import type { SearchDoc, SearchHit } from "./searchEngine";

// Wire protocol between the search worker and the UI thread (Task 3 consumes
// these exact names). The index builds LAZILY: 'init' answers 'ready' without
// touching the DB, and the first non-empty query performs the rebuild.

export type SearchWorkerRequest =
  | { type: "init" }
  | { type: "invalidate" }
  | { type: "query"; requestId: number; query: string; limit: number };

export type SearchWorkerResponse =
  | { type: "ready" }
  | { type: "results"; requestId: number; hits: SearchHit[] }
  | { type: "error"; requestId?: number; message: string };

// Injectable deps so unit tests drive the handler without a real Worker or
// IndexedDB (precedent: proSync.worker.ts refreshTokenAndRetry deps).
export interface SearchWorkerDeps {
  db: {
    files: { toArray(): Promise<DriveFile[]> };
    metadataCache: { toArray(): Promise<MetadataCacheRow[]> };
  };
  build: (
    files: DriveFile[],
    meta: ReadonlyMap<string, CachedMetadata>,
  ) => MiniSearch<SearchDoc>;
  query: typeof queryIndex;
  post: (r: SearchWorkerResponse) => void;
}

// Rebuild pipeline state. Module-level so the worker's onmessage glue and the
// hook's inline fallback share ONE source of truth; vitest keeps it fresh per
// test FILE, and tests reset it per case via resetSearchWorkerState().
export interface SearchWorkerState {
  index: MiniSearch<SearchDoc> | null;
  stale: boolean;
  rebuildPromise: Promise<void> | null;
}

export function createSearchWorkerState(): SearchWorkerState {
  return { index: null, stale: true, rebuildPromise: null };
}

export const searchWorkerState: SearchWorkerState = createSearchWorkerState();

// Bumped on every invalidate so an in-flight rebuild can detect that its DB
// snapshot predates the invalidation and must not publish a stale index.
let rebuildGeneration = 0;

// Test seam: wipes the module-level index state between test cases.
export function resetSearchWorkerState(): void {
  searchWorkerState.index = null;
  searchWorkerState.stale = true;
  searchWorkerState.rebuildPromise = null;
  rebuildGeneration = 0;
}

export function isSearchWorkerRequest(
  data: unknown,
): data is SearchWorkerRequest {
  if (typeof data !== "object" || data === null) return false;
  if (!("type" in data)) return false;
  const type = (data as { type?: unknown }).type;
  if (type === "init" || type === "invalidate") return true;
  if (type === "query") {
    const req = data as {
      requestId?: unknown;
      query?: unknown;
      limit?: unknown;
    };
    return (
      typeof req.requestId === "number" &&
      typeof req.query === "string" &&
      typeof req.limit === "number"
    );
  }
  return false;
}

export function isSearchWorkerResponse(
  data: unknown,
): data is SearchWorkerResponse {
  if (typeof data !== "object" || data === null) return false;
  const r = data as {
    type?: unknown;
    requestId?: unknown;
    message?: unknown;
    hits?: unknown;
  };
  if (r.type === "ready") return true;
  if (r.type === "results") {
    return typeof r.requestId === "number" && Array.isArray(r.hits);
  }
  if (r.type === "error") {
    return (
      typeof r.message === "string" &&
      (r.requestId === undefined || typeof r.requestId === "number")
    );
  }
  return false;
}

// Classified error surfacing: every failure posts {type:'error'} with the
// failing phase in the message so the main thread can log with context.
function errorMessage(prefix: string, err: unknown): string {
  return `${prefix}: ${err instanceof Error ? err.message : String(err)}`;
}

// Reads the full library + real metadata and builds a fresh index. Only the
// rebuild path touches the DB, so idle workers cost nothing.
//
// Per-user scoping (schema v10): this read stays UNSCOPED for now because the
// real worker realm has no channel carrying the active account's email (the
// wire protocol only passes query/invalidate/init, and workers have no
// localStorage). Scoping happens at the main-thread boundary instead
// (createInlineExecutor in useSearchWorker.ts); wiring the email through the
// message protocol lands with the sync-worker email work in step 3 of the
// parent-normalization plan. Until then a multi-account local mirror would be
// indexed across owners — accepted for this step, same as the sync worker
// stamping rows with the default sentinel.
async function performRebuild(deps: SearchWorkerDeps): Promise<void> {
  const generation = rebuildGeneration;
  const [files, metaRows] = await Promise.all([
    deps.db.files.toArray(),
    deps.db.metadataCache.toArray(),
  ]);
  const realMeta = loadRealMetadata(metaRows);
  if (generation !== rebuildGeneration) {
    // An invalidate landed while the DB reads were in flight: this snapshot is
    // already stale, so don't publish it — the next query rebuilds fresh.
    return;
  }
  searchWorkerState.index = deps.build(files, realMeta);
  searchWorkerState.stale = false;
}

// Serializes rebuilds: concurrent queries while stale share ONE rebuild
// promise instead of racing. On failure the promise is cleared but stale
// stays true, so the next query retries instead of serving a broken index.
function ensureFreshIndex(deps: SearchWorkerDeps): Promise<void> {
  if (searchWorkerState.index !== null && !searchWorkerState.stale) {
    return Promise.resolve();
  }
  if (searchWorkerState.rebuildPromise === null) {
    searchWorkerState.rebuildPromise = performRebuild(deps).finally(() => {
      searchWorkerState.rebuildPromise = null;
    });
  }
  return searchWorkerState.rebuildPromise;
}

async function handleQuery(
  msg: Extract<SearchWorkerRequest, { type: "query" }>,
  deps: SearchWorkerDeps,
): Promise<void> {
  if (msg.query.trim() === "") {
    // Empty queries never touch the index — the UI shows the normal listing.
    deps.post({ type: "results", requestId: msg.requestId, hits: [] });
    return;
  }
  try {
    await ensureFreshIndex(deps);
  } catch (err) {
    deps.post({
      type: "error",
      requestId: msg.requestId,
      message: errorMessage("rebuild-failed", err),
    });
    return;
  }
  if (searchWorkerState.index === null) {
    // Unreachable after a successful rebuild; defensive for strict null-safety.
    deps.post({
      type: "error",
      requestId: msg.requestId,
      message: "rebuild-failed: index missing after rebuild",
    });
    return;
  }
  try {
    const hits = deps.query(searchWorkerState.index, msg.query, msg.limit);
    deps.post({ type: "results", requestId: msg.requestId, hits });
  } catch (err) {
    deps.post({
      type: "error",
      requestId: msg.requestId,
      message: errorMessage("query-failed", err),
    });
  }
}

export async function handleSearchWorkerMessage(
  msg: SearchWorkerRequest,
  deps: SearchWorkerDeps,
): Promise<void> {
  if (!isSearchWorkerRequest(msg)) return;
  switch (msg.type) {
    case "init":
      deps.post({ type: "ready" });
      return;
    case "invalidate":
      searchWorkerState.stale = true;
      rebuildGeneration++;
      return;
    case "query":
      await handleQuery(msg, deps);
      return;
  }
}

// Worker glue — attached ONLY inside a real worker scope (window absent), so
// importing this module on the main thread (the hook's inline fallback) never
// installs a stray window 'message' listener.
if (typeof self !== "undefined" && typeof window === "undefined") {
  const workerDeps: SearchWorkerDeps = {
    db,
    build: buildSearchIndex,
    query: queryIndex,
    post: (r) => {
      self.postMessage(r);
    },
  };
  self.onmessage = (e: MessageEvent) => {
    if (!isSearchWorkerRequest(e.data)) return;
    void handleSearchWorkerMessage(e.data, workerDeps);
  };
}
