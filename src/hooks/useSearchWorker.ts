import { useEffect, useRef, useState } from "react";
import { db } from "../db/db";
import { captureError } from "../utils/errorLog";
import { SYNC_EVENT_NAMES } from "../utils/proSyncManager";
import { buildSearchIndex, queryIndex } from "../search/searchEngine";
import type { SearchHit } from "../search/searchEngine";
import {
  handleSearchWorkerMessage,
  isSearchWorkerResponse,
  type SearchWorkerDeps,
  type SearchWorkerRequest,
  type SearchWorkerResponse,
} from "../search/search.worker";
import { getCurrentUserEmail } from "../utils/storageKeys";

const DEBOUNCE_MS = 150;
const INVALIDATE_THROTTLE_MS = 300;
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

function createWorkerExecutor(): SearchExecutor {
  const worker = new Worker(
    new URL("../search/search.worker.ts", import.meta.url),
    { type: "module" },
  );
  const listeners = new Set<(r: SearchWorkerResponse) => void>();
  worker.onmessage = (e: MessageEvent) => {
    // typeof-narrow first: MessageEvent.data is `any`; the guard keeps the
    // listener loop strict-typed.
    if (typeof e.data !== "object" || e.data === null) return;
    if (!isSearchWorkerResponse(e.data)) return;
    for (const listener of listeners) listener(e.data);
  };
  worker.onerror = (e: ErrorEvent) => {
    // A crashed worker must not crash the UI: log and keep last-good hits.
    void captureError({
      level: "warn",
      source: "searchWorker",
      message: `worker-error: ${e.message}`,
    });
  };
  worker.onmessageerror = () => {
    void captureError({
      level: "warn",
      source: "searchWorker",
      message: "worker-messageerror: malformed message from worker",
    });
  };
  return {
    post: (msg) => {
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
  // Main-thread boundary scoping (schema v10): the index only sees the active
  // account's rows here. The real worker path reads all rows for now — it has
  // no email channel until step 3 wires one through the message protocol
  // (see performRebuild in search.worker.ts).
  const deps: SearchWorkerDeps = {
    db: {
      files: {
        toArray: async () => {
          const owner = getCurrentUserEmail();
          return (await db.files.toArray()).filter(
            (row) => row.userEmail === owner,
          );
        },
      },
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
): { hits: SearchHit[] } {
  const [hits, setHits] = useState<SearchHit[]>([]);
  const executorRef = useRef<SearchExecutor | null>(null);
  const latestRequestIdRef = useRef(0);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const invalidateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // One executor for the hook's lifetime, plus the freshness subscriptions:
  // main-thread Dexie hooks cover writes from upload/explorer/on-demand
  // fetch, while the pro-sync CustomEvents cover writes the proSync worker
  // makes on its OWN connection (invisible to main-thread hooks).
  useEffect(() => {
    const executor = executorFactory();
    executorRef.current = executor;
    executor.onResponse((response) => {
      if (response.type === "results") {
        // Out-of-order responses (an older query resolving after a newer one)
        // are dropped; last-good hits stay until the newer result lands.
        if (response.requestId !== latestRequestIdRef.current) return;
        setHits(response.hits);
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
      window.removeEventListener(PRO_SYNC_PROGRESS_EVENT, onProSyncProgress);
      window.removeEventListener(PRO_SYNC_COMPLETE_EVENT, onProSyncComplete);
      executor.terminate();
      if (executorRef.current === executor) executorRef.current = null;
    };
  }, []);

  // Debounced query dispatch. Empty queries short-circuit: nothing reaches
  // the executor, and the returned hits derive to [] (normal listing) — the
  // requestId bump drops any still-in-flight response from a previous query.
  useEffect(() => {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    if (query.trim() === "") {
      latestRequestIdRef.current += 1;
      return;
    }
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      const executor = executorRef.current;
      if (executor === null) return; // unmounted before the debounce elapsed
      latestRequestIdRef.current += 1;
      executor.post({
        type: "query",
        requestId: latestRequestIdRef.current,
        query,
        limit,
      });
    }, DEBOUNCE_MS);
  }, [query, limit]);

  return { hits: query.trim() === "" ? [] : hits };
}
