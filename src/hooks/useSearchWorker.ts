import { useEffect, useMemo, useRef, useState } from "react";
import { db } from "../db/db";
import { captureError } from "../utils/errorLog";
import { SYNC_EVENT_NAMES } from "../utils/proSyncManager";
import { getCurrentUserEmail } from "../utils/storageKeys";
import { useAuthStore } from "../store/authStore";
import { buildSearchIndex, queryIndex } from "../search/searchEngine";
import type { SearchHit } from "../search/searchEngine";
import {
  handleSearchWorkerMessage,
  isSearchWorkerResponse,
  type SearchQueryContext,
  type SearchWorkerDeps,
  type SearchWorkerRequest,
  type SearchWorkerResponse,
} from "../search/search.worker";

export type { SearchQueryContext } from "../search/search.worker";

const DEBOUNCE_MS = 150;
const INVALIDATE_THROTTLE_MS = 300;
// Identity separator: NUL never occurs in a query/folder/email, so joining
// the identity parts stays unambiguous.
const IDENTITY_SEPARATOR = "\u0000";
// Event names come from proSyncManager so the main->UI protocol never drifts
// from the strings the manager dispatches.
const PRO_SYNC_PROGRESS_EVENT = SYNC_EVENT_NAMES.progress;
const PRO_SYNC_COMPLETE_EVENT = SYNC_EVENT_NAMES.complete;
const ERROR_SOURCE = "useSearchWorker";

// Narrow transport between the hook and the search engine. Worker mode
// wraps a real Worker; inline mode runs the worker's own message handler
// in-process (vitest jsdom has no Worker), so both paths share ONE pipeline
// — no second, divergent implementation.
export interface SearchExecutor {
  post: (msg: SearchWorkerRequest) => void;
  onResponse: (listener: (r: SearchWorkerResponse) => void) => void;
  terminate: () => void;
}

const WORKER_CRASHED_MESSAGE = "worker-crashed";

// `new Worker` can throw synchronously (WHATWG HTML: SyntaxError on a bad URL,
// SecurityError on a blocked script) — log and let the caller fall back to the
// inline executor instead of breaking the whole hook effect.
function createWorkerInstance(): Worker | null {
  try {
    return new Worker(new URL("../search/search.worker.ts", import.meta.url), {
      type: "module",
    });
  } catch (e: unknown) {
    void captureError({
      level: "error",
      source: "searchWorker",
      message: `worker-create-failed: ${e instanceof Error ? e.message : String(e)}`,
    });
    return null;
  }
}

function createWorkerExecutor(): SearchExecutor {
  const listeners = new Set<(r: SearchWorkerResponse) => void>();
  // A crashed/terminated worker has its port message queue emptied (WHATWG
  // HTML "terminate a worker"), so every later postMessage would vanish
  // silently — `dead` forces a recreate on the next post instead.
  let dead = false;

  const bind = (worker: Worker): void => {
    worker.onmessage = (e: MessageEvent) => {
      // typeof-narrow first: MessageEvent.data is `any`; the guard keeps the
      // listener loop strict-typed.
      if (typeof e.data !== "object" || e.data === null) return;
      if (!isSearchWorkerResponse(e.data)) return;
      for (const listener of listeners) listener(e.data);
    };
    worker.onerror = (e: ErrorEvent) => {
      // A crashed worker must not crash the UI: mark it dead, log at error
      // level and surface a synthetic error so the UI can react — without
      // this the search would just hang forever on a dead worker.
      dead = true;
      void captureError({
        level: "error",
        source: "searchWorker",
        message: `worker-error: ${e.message}`,
      });
      for (const listener of listeners)
        listener({ type: "error", message: WORKER_CRASHED_MESSAGE });
    };
    worker.onmessageerror = () => {
      void captureError({
        level: "warn",
        source: "searchWorker",
        message: "worker-messageerror: malformed message from worker",
      });
    };
  };

  const initialWorker = createWorkerInstance();
  if (initialWorker === null) return createInlineExecutor();
  let worker: Worker = initialWorker;
  bind(worker);

  return {
    post: (msg) => {
      if (dead) {
        // Recreate lazily on the next post: the fresh worker rebuilds its
        // index on the first query. One attempt per post bounds the
        // crash -> recreate -> crash cycle (a failing create is logged and
        // leaves dead=true, dropping that post).
        const recreated = createWorkerInstance();
        if (recreated === null) return;
        worker = recreated;
        dead = false;
        bind(worker);
      }
      worker.postMessage(msg);
    },
    onResponse: (listener) => {
      listeners.add(listener);
    },
    terminate: () => {
      worker.terminate();
    },
  };
}

function createInlineExecutor(): SearchExecutor {
  const listeners = new Set<(r: SearchWorkerResponse) => void>();
  // Scoping (schema v10): the owner email travels on every query frame and
  // performRebuild filters there — ONE filter point shared with the real
  // worker path (no separate main-thread filter).
  const deps: SearchWorkerDeps = {
    db: {
      files: db.files,
      metadataCache: db.metadataCache,
    },
    build: buildSearchIndex,
    query: queryIndex,
    post: (r) => {
      for (const listener of listeners) listener(r);
    },
  };
  return {
    // The exact handler the worker runs, on the same module-level state.
    post: (msg) => {
      void handleSearchWorkerMessage(msg, deps);
    },
    onResponse: (listener) => {
      listeners.add(listener);
    },
    terminate: () => {
      // Drop every listener so a late inline response after unmount can never
      // reach React (mirrors worker.terminate()).
      listeners.clear();
    },
  };
}

export function createSearchExecutor(): SearchExecutor {
  if (typeof Worker !== "undefined") return createWorkerExecutor();
  return createInlineExecutor();
}

// Test seam: vitest swaps in a fake executor for deterministic response
// ordering; production always uses createSearchExecutor().
let executorFactory: () => SearchExecutor = createSearchExecutor;

export function setSearchExecutorFactoryForTests(
  factory: () => SearchExecutor,
): void {
  executorFactory = factory;
}

export function useSearchWorker(
  query: string,
  limit: number,
  context: SearchQueryContext,
): { hits: SearchHit[] } {
  // Request identity = everything a result depends on. Results are only ever
  // exposed when their identity matches the CURRENT one, so a scope/account/
  // sort switch hides stale hits in the same render instead of waiting for
  // the debounce + a round-trip.
  const [result, setResult] = useState<{
    identity: string;
    hits: SearchHit[];
  } | null>(null);
  const executorRef = useRef<SearchExecutor | null>(null);
  const latestRequestIdRef = useRef(0);
  const inFlightIdentityRef = useRef("");
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const invalidateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reactive owner: the auth store is the live source (written by
  // useAuthProfileSync at the same instant as localStorage). The localStorage
  // read is only the pre-hydration fallback; the store subscription re-renders
  // on login/logout, which changes the identity below.
  const storeEmail = useAuthStore((s) => s.userProfile?.email ?? "");
  const accountEmail = storeEmail !== "" ? storeEmail : getCurrentUserEmail();

  const rootsKey = useMemo(
    () => [...context.rootIds].sort().join(IDENTITY_SEPARATOR),
    [context.rootIds],
  );
  const identity = useMemo(
    () =>
      [
        query,
        accountEmail,
        rootsKey,
        context.mode,
        context.currentFolderId ?? "",
        context.sortField,
        context.sortDir,
      ].join(IDENTITY_SEPARATOR),
    [
      query,
      accountEmail,
      rootsKey,
      context.mode,
      context.currentFolderId,
      context.sortField,
      context.sortDir,
    ],
  );

  // One executor for the hook's lifetime, plus the freshness subscriptions:
  // main-thread Dexie hooks cover writes from upload/explorer/on-demand
  // fetch, while the pro-sync CustomEvents cover writes the proSync worker
  // makes on its OWN connection (invisible to main-thread hooks). The
  // metadataCache hooks (B4) join the same throttled invalidation so a fresh
  // title/artist lands in the index on the next query — Dexie's hooks
  // middleware fires per-row for bulkPut AND chunks clear() into per-row
  // deletes, so no separate wipe subscription is needed (verified:
  // node_modules/dexie/dist/dexie.mjs:4937-5060).
  useEffect(() => {
    const executor = executorFactory();
    executorRef.current = executor;
    executor.onResponse((response) => {
      if (response.type === "results") {
        // Two layers of staleness protection: the requestId check drops an
        // older query resolving after a newer one (last-good hits stay until
        // the newer result lands), and the identity stored at dispatch time
        // keeps the result bound to the scope/account/sort it was produced
        // for — a mismatched identity is never exposed (see `hits` below).
        if (response.requestId !== latestRequestIdRef.current) return;
        setResult({
          identity: inFlightIdentityRef.current,
          hits: response.hits,
        });
        return;
      }
      if (response.type === "error") {
        void captureError({
          level: "warn",
          source: ERROR_SOURCE,
          message: `search-error: ${response.message}`,
        });
      }
    });

    // Throttled invalidation: burst writes (e.g. a bulk import) collapse into
    // one stale-flag; the rebuild itself stays lazy (next non-empty query).
    const scheduleInvalidate = () => {
      if (invalidateTimerRef.current !== null) return;
      invalidateTimerRef.current = setTimeout(() => {
        invalidateTimerRef.current = null;
        executor.post({ type: "invalidate" });
      }, INVALIDATE_THROTTLE_MS);
    };
    const onFilesChanged = () => {
      scheduleInvalidate();
    };
    const onProSyncProgress = () => {
      scheduleInvalidate();
    };
    const onProSyncComplete = () => {
      scheduleInvalidate();
    };
    db.files.hook("creating", onFilesChanged);
    db.files.hook("updating", onFilesChanged);
    db.files.hook("deleting", onFilesChanged);
    // Metadata writes (title/artist parsed async after upload) must reach the
    // index too: putCacheEntry/setCache put one row, fetchPipeline puts rows,
    // LRU evict deletes one row, wipePersistedMetadataCache clear() chunks
    // into per-row deletes — every path fires one of the hooks below.
    db.metadataCache.hook("creating", onFilesChanged);
    db.metadataCache.hook("updating", onFilesChanged);
    db.metadataCache.hook("deleting", onFilesChanged);
    window.addEventListener(PRO_SYNC_PROGRESS_EVENT, onProSyncProgress);
    window.addEventListener(PRO_SYNC_COMPLETE_EVENT, onProSyncComplete);

    return () => {
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      if (invalidateTimerRef.current !== null) {
        clearTimeout(invalidateTimerRef.current);
        invalidateTimerRef.current = null;
      }
      db.files.hook("creating").unsubscribe(onFilesChanged);
      db.files.hook("updating").unsubscribe(onFilesChanged);
      db.files.hook("deleting").unsubscribe(onFilesChanged);
      db.metadataCache.hook("creating").unsubscribe(onFilesChanged);
      db.metadataCache.hook("updating").unsubscribe(onFilesChanged);
      db.metadataCache.hook("deleting").unsubscribe(onFilesChanged);
      window.removeEventListener(PRO_SYNC_PROGRESS_EVENT, onProSyncProgress);
      window.removeEventListener(PRO_SYNC_COMPLETE_EVENT, onProSyncComplete);
      executor.terminate();
      if (executorRef.current === executor) executorRef.current = null;
    };
  }, []);

  // Root ids derived from the CONTENT key, not the caller's array identity: a
  // caller that builds the array inline on every render must not make the
  // dispatch effect re-fire (that would bump the requestId per render forever).
  const postedRootIds = useMemo(
    () =>
      rootsKey === "" ? [] : rootsKey.split(IDENTITY_SEPARATOR).filter(Boolean),
    [rootsKey],
  );

  // The exact frame posted for this identity. Memoized on its content so the
  // dispatch effect depends on ONE stable object instead of reaching into
  // `context` (which callers re-create per render).
  const dispatchFrame = useMemo(
    () => ({
      query,
      limit,
      // Same value the identity above uses, so the index scope and the result
      // identity can never disagree about the owner.
      userEmail: accountEmail,
      context: {
        mode: context.mode,
        rootIds: postedRootIds,
        ...(context.currentFolderId !== undefined
          ? { currentFolderId: context.currentFolderId }
          : {}),
        sortField: context.sortField,
        sortDir: context.sortDir,
      },
    }),
    [
      query,
      limit,
      accountEmail,
      postedRootIds,
      context.mode,
      context.currentFolderId,
      context.sortField,
      context.sortDir,
    ],
  );

  // Debounced query dispatch. Empty queries short-circuit: nothing reaches
  // the executor, and the returned hits derive to [] (normal listing) — the
  // requestId bump drops any still-in-flight response from a previous query.
  // The identity (query/account/mode/roots/folder/sort) rides on every frame;
  // the effect re-runs when it changes so a mode/sort switch re-queries
  // WITHOUT the user retyping.
  //
  // The requestId bump happens IMMEDIATELY on an identity change (not inside
  // the debounce timer): a stale response that lands during the debounce
  // window must be dropped by requestId, and the identity bound to the
  // previous dispatch no longer matches the render-time identity anyway.
  useEffect(() => {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    latestRequestIdRef.current += 1;
    if (dispatchFrame.query.trim() === "") return;
    const scheduledIdentity = identity;
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      const executor = executorRef.current;
      if (executor === null) return; // unmounted before the debounce elapsed
      inFlightIdentityRef.current = scheduledIdentity;
      executor.post({
        type: "query",
        requestId: latestRequestIdRef.current,
        ...dispatchFrame,
      });
    }, DEBOUNCE_MS);
  }, [identity, dispatchFrame]);

  // Render-derived exposure rule: a result is only visible while it belongs
  // to the identity being rendered. An identity switch therefore clears the
  // visible hits in the SAME render — no effect, no debounce, no round-trip.
  const hits =
    result !== null && result.identity === identity ? result.hits : [];
  return { hits: query.trim() === "" ? [] : hits };
}
