import type MiniSearch from "minisearch";
import { db } from "../db/db";
import type { DriveFile, MetadataCacheRow } from "../db/db";
import type { CachedMetadata } from "../utils/metadata";
import {
  buildSearchIndex,
  buildParentToChildren,
  computeRootMembership,
  loadRealMetadata,
  queryIndex,
} from "./searchEngine";
import type { SearchDoc, SearchQueryScope, SearchHit } from "./searchEngine";

// Wire protocol between the search worker and the UI thread (Task 3 consumes
// these exact names). The index builds LAZILY: 'init' answers 'ready' without
// touching the DB, and the first non-empty query performs the rebuild.

export interface SearchQueryContext {
  mode: "global" | "recursive";
  rootIds: string[];
  currentFolderId?: string;
  sortField: "relevance" | "name" | "modifiedTime" | "size";
  sortDir: "asc" | "desc";
}

export type SearchWorkerRequest =
  | { type: "init" }
  | { type: "invalidate" }
  | {
      type: "query";
      requestId: number;
      query: string;
      limit: number;
      userEmail: string;
      /** Root/sort scope. REQUIRED (fail-closed): every query must state the
       * roots it is scoped to, so a frame can never degrade into an unscoped
       * global query. A frame without a valid context is rejected by the wire
       * guard and answers nothing. */
      context: SearchQueryContext;
    };

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
  rebuildPromise: Promise<boolean> | null;
  /** Owner whose rows the CURRENT index was built from (null = no index). */
  indexOwnerEmail: string | null;
}

export function createSearchWorkerState(): SearchWorkerState {
  return {
    index: null,
    stale: true,
    rebuildPromise: null,
    indexOwnerEmail: null,
  };
}

export const searchWorkerState: SearchWorkerState = createSearchWorkerState();

// Bumped on every invalidate so an in-flight rebuild can detect that its DB
// snapshot predates the invalidation and must not publish a stale index.
let rebuildGeneration = 0;

// The account the current index was built for. The worker realm has no
// localStorage, so the owner rides on every query frame (same pattern as the
// sync worker's "userEmail on the wire frame"); a change forces a rebuild
// scoped to the new owner before anything is served.
let activeOwnerEmail: string | null = null;

// Root-membership cache (B1.3): the O(n) BFS over the whole index reruns only
// when the owner, the root set, or the index generation changes — NOT on
// every keystroke. Signature = owner + sorted root ids.
let membershipCache: {
  signature: string;
  parentToChildren: Map<string, Set<string>>;
  inRootIds: Set<string>;
} | null = null;

function membershipSignature(ownerEmail: string, rootIds: string[]): string {
  return `${ownerEmail}|${[...rootIds].sort().join("|")}`;
}

function resetMembershipCache(): void {
  membershipCache = null;
}

// Resolves (or reuses) the cached membership artifacts for this query frame.
// rootIds are deduped/sorted by the signature; an EMPTY list yields an empty
// membership (fail closed — the caller answers [] without touching the
// index) without paying for a BFS.
function resolveMembership(
  index: MiniSearch<SearchDoc>,
  ownerEmail: string,
  rootIds: string[],
): {
  parentToChildren: Map<string, Set<string>>;
  inRootIds: Set<string>;
} | null {
  if (rootIds.length === 0) return null;
  const signature = membershipSignature(ownerEmail, rootIds);
  if (membershipCache && membershipCache.signature === signature) {
    return membershipCache;
  }
  const parentToChildren = buildParentToChildren(index);
  const inRootIds = computeRootMembership(index, parentToChildren, rootIds);
  membershipCache = { signature, parentToChildren, inRootIds };
  return membershipCache;
}

// Test seam: wipes the module-level index state between test cases.
export function resetSearchWorkerState(): void {
  searchWorkerState.index = null;
  searchWorkerState.stale = true;
  searchWorkerState.rebuildPromise = null;
  searchWorkerState.indexOwnerEmail = null;
  rebuildGeneration = 0;
  activeOwnerEmail = null;
  resetMembershipCache();
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
      userEmail?: unknown;
      context?: unknown;
    };
    if (
      typeof req.requestId !== "number" ||
      typeof req.query !== "string" ||
      typeof req.limit !== "number" ||
      typeof req.userEmail !== "string"
    ) {
      return false;
    }
    // context is REQUIRED (fail-closed): a frame without a valid scope is
    // rejected here and nothing is queried — no unscoped fallback exists.
    if (typeof req.context !== "object" || req.context === null) return false;
    const ctx = req.context as {
      mode?: unknown;
      rootIds?: unknown;
      currentFolderId?: unknown;
      sortField?: unknown;
      sortDir?: unknown;
    };
    // Recursive mode MUST name its folder (fail-closed): a recursive frame
    // without a non-empty currentFolderId is a lost-context bug, not a
    // request for the global scope — reject it instead of widening the search.
    if (
      ctx.mode === "recursive" &&
      (typeof ctx.currentFolderId !== "string" || ctx.currentFolderId === "")
    ) {
      return false;
    }
    return (
      (ctx.mode === "global" || ctx.mode === "recursive") &&
      Array.isArray(ctx.rootIds) &&
      ctx.rootIds.every((id) => typeof id === "string" && id.length > 0) &&
      (ctx.currentFolderId === undefined ||
        typeof ctx.currentFolderId === "string") &&
      (ctx.sortField === "relevance" ||
        ctx.sortField === "name" ||
        ctx.sortField === "modifiedTime" ||
        ctx.sortField === "size") &&
      (ctx.sortDir === "asc" || ctx.sortDir === "desc")
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
// Per-user scoping (schema v10): the DB read stays whole-table, but the index
// only ever sees the ACTIVE owner's rows — the email rides on every query
// frame (activeOwnerEmail above) because the worker realm has no localStorage.
// This is the single filter point shared by the real worker and the inline
// executor; the metadataCache is intentionally NOT scoped (its keys are
// globally unique fileIds and rows carry no userEmail).
async function performRebuild(deps: SearchWorkerDeps): Promise<boolean> {
  const generation = rebuildGeneration;
  const owner = activeOwnerEmail;
  const [files, metaRows] = await Promise.all([
    deps.db.files.toArray(),
    deps.db.metadataCache.toArray(),
  ]);
  const realMeta = loadRealMetadata(metaRows);
  if (generation !== rebuildGeneration || owner !== activeOwnerEmail) {
    // An invalidate (or an owner switch) landed while the DB reads were in
    // flight: this snapshot is already stale, so don't publish it — the next
    // query rebuilds fresh.
    return false;
  }
  const ownerRows =
    owner === null ? files : files.filter((f) => f.userEmail === owner);
  searchWorkerState.index = deps.build(ownerRows, realMeta);
  searchWorkerState.stale = false;
  searchWorkerState.indexOwnerEmail = owner;
  // The membership/adjacency cache describes the PREVIOUS index; a new index
  // must never be queried through it (hierarchy/moves would leak stale edges).
  resetMembershipCache();
  return true;
}

// Serializes rebuilds: concurrent queries while stale share ONE rebuild
// promise instead of racing. Resolves true when a USABLE index was published
// by that rebuild, false when it was aborted (invalidate/owner switch).
// On failure the promise is cleared but stale stays true, so the next query
// retries instead of serving a broken index.
function ensureFreshIndex(deps: SearchWorkerDeps): Promise<boolean> {
  if (searchWorkerState.index !== null && !searchWorkerState.stale) {
    return Promise.resolve(true);
  }
  if (searchWorkerState.rebuildPromise === null) {
    searchWorkerState.rebuildPromise = performRebuild(deps).finally(() => {
      searchWorkerState.rebuildPromise = null;
    });
  }
  return searchWorkerState.rebuildPromise;
}

// Bounded attempts: an invalidate storm (bulk import) must never spin the
// handler forever. Each attempt rebuilds against the LATEST snapshot, so a
// request that keeps losing the race gives up with an empty answer instead of
// serving an index that fails the freshness check.
const MAX_REBUILD_ATTEMPTS = 3;

// A published index may only serve a query when it was built from the CURRENT
// owner's rows and has not been invalidated since. Everything else fails
// closed (never query an index that fails this predicate).
function isIndexUsableFor(userEmail: string): boolean {
  const st = searchWorkerState;
  return (
    st.index !== null &&
    !st.stale &&
    st.indexOwnerEmail === userEmail &&
    activeOwnerEmail === userEmail
  );
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
  // Root scope (I1/B2): an empty rootIds list fails closed — no hits —
  // without touching the index at all (no rebuild, no BFS). The context is
  // mandatory on the wire, so there is no unscoped path left.
  const context = msg.context;
  if (context.rootIds.length === 0) {
    deps.post({ type: "results", requestId: msg.requestId, hits: [] });
    return;
  }
  for (let attempt = 0; attempt < MAX_REBUILD_ATTEMPTS; attempt += 1) {
    let published = false;
    try {
      published = await ensureFreshIndex(deps);
    } catch (err) {
      deps.post({
        type: "error",
        requestId: msg.requestId,
        message: errorMessage("rebuild-failed", err),
      });
      return;
    }
    if (isIndexUsableFor(msg.userEmail)) break;
    // Owner mismatch is permanent for THIS request (the frame belongs to the
    // previous account): answer empty, never retry against the new owner.
    if (activeOwnerEmail !== msg.userEmail) {
      deps.post({ type: "results", requestId: msg.requestId, hits: [] });
      return;
    }
    // Nothing was published and this was the last attempt: give up with a
    // SAFE empty answer (never an index that failed the freshness check).
    if (!published && attempt === MAX_REBUILD_ATTEMPTS - 1) {
      deps.post({ type: "results", requestId: msg.requestId, hits: [] });
      return;
    }
    // Otherwise loop: the next ensureFreshIndex() rebuilds from the snapshot
    // taken after the invalidate that aborted the previous attempt.
  }
  // Final re-assertion after the loop (a concurrent rebuild/invalidate may
  // have landed between the last await and this point).
  if (!isIndexUsableFor(msg.userEmail) || searchWorkerState.index === null) {
    deps.post({ type: "results", requestId: msg.requestId, hits: [] });
    return;
  }
  try {
    const membership = resolveMembership(
      searchWorkerState.index,
      msg.userEmail,
      context.rootIds,
    );
    const scope: SearchQueryScope = {
      mode: context.mode,
      rootIds: context.rootIds,
      ...(context.currentFolderId !== undefined
        ? { currentFolderId: context.currentFolderId }
        : {}),
      ...(membership ?? {}),
    };
    const sortSpec = { field: context.sortField, dir: context.sortDir };
    const hits = deps.query(
      searchWorkerState.index,
      msg.query,
      msg.limit,
      scope,
      sortSpec,
    );
    deps.post({ type: "results", requestId: msg.requestId, hits });
  } catch (err) {
    deps.post({
      type: "error",
      requestId: msg.requestId,
      message: errorMessage("query-failed", err),
    });
  }
}

// A query frame that fails the wire guard still gets an explicit fail-closed
// answer () for its requestId when it carries one, so the UI can never
// wait forever and the pipeline has no silent hole. Frames that are not a
// query at all (or carry no numeric requestId) stay dropped.
function failClosedQueryRequestId(data: unknown): number | null {
  if (typeof data !== "object" || data === null) return null;
  const frame = data as { type?: unknown; requestId?: unknown };
  if (frame.type !== "query") return null;
  return typeof frame.requestId === "number" ? frame.requestId : null;
}

export async function handleSearchWorkerMessage(
  msg: SearchWorkerRequest,
  deps: SearchWorkerDeps,
): Promise<void> {
  if (!isSearchWorkerRequest(msg)) {
    const requestId = failClosedQueryRequestId(msg);
    if (requestId !== null) {
      deps.post({ type: "results", requestId, hits: [] });
    }
    return;
  }
  switch (msg.type) {
    case "init":
      deps.post({ type: "ready" });
      return;
    case "invalidate":
      searchWorkerState.stale = true;
      rebuildGeneration++;
      // The cached membership describes the OLD index — any index change
      // (file added/removed/moved) invalidates it together with the index.
      resetMembershipCache();
      return;
    case "query":
      if (msg.userEmail !== activeOwnerEmail) {
        // Account switch: the current index belongs to the previous owner, so
        // it must not serve this (or any) query. Force a fresh scoped rebuild
        // and abort any in-flight rebuild that would publish the old owner's
        // snapshot (same generation guard as invalidate).
        activeOwnerEmail = msg.userEmail;
        searchWorkerState.stale = true;
        rebuildGeneration++;
        resetMembershipCache();
      }
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
    if (!isSearchWorkerRequest(e.data)) {
      const requestId = failClosedQueryRequestId(e.data);
      if (requestId !== null) {
        self.postMessage({ type: "results", requestId, hits: [] });
      }
      return;
    }
    void handleSearchWorkerMessage(e.data, workerDeps);
  };
}
