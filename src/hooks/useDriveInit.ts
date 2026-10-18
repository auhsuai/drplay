import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { useShallow } from "zustand/react/shallow";
import { invoke } from "@tauri-apps/api/core";
import { db } from "../db/db";
import { wipeFileRowsForUser } from "../db/fileRows";
import { getAppConfig, FOLDER_MIME } from "../utils/driveApi";
import { getValidToken, fetchWithAuth } from "../utils/apiClient";
import { CLEAR_LOCAL_CACHE_CMD } from "../utils/cache";
import {
  ROOT_FOLDER_ID,
  MY_DRIVE_TAB,
  VIRTUAL_ROOT_ID,
  VIRTUAL_ROOT_NAME,
} from "../utils/driveConstants";
import { authHeaders, DRIVE_FILES_URL } from "../utils/driveFiles";
import {
  parseRootFolders,
  rootsSignature,
  type RootFolder,
} from "../utils/rootFolders";
import { useDriveStore } from "../store/driveStore";
import { captureError } from "../utils/errorLog";
import {
  DEFAULT_USER_EMAIL,
  getCurrentUserEmail,
  ROOT_FOLDER_KEY,
  ROOT_FOLDERS_KEY,
  ROOT_FOLDERS_UPDATED_KEY,
  CURRENT_FOLDER_ID_KEY,
  CURRENT_FOLDER_NAME_KEY,
  FOLDER_HISTORY_KEY,
  SORT_OPTION_KEY,
  DB_NAV_STATE_KEY,
  safeLocalStorageGet,
  safeLocalStorageSet,
} from "../utils/storageKeys";
import { classifyError } from "./useDriveShared";

// Exactly the fields the root verification needs: the real name (refresh),
// the folder mimeType and driveId (Shared Drive folders are rejected).
const VERIFY_FIELDS = "id,name,driveId,mimeType";

// Validates the persisted folder-history shape the same way the Dexie branch
// does: an entry survives only when it is an object with a string `id`. The
// type predicate narrows `name` as string even though runtime only checks
// `id` — identical to the inline filter it replaces.
function parseNavHistory(value: unknown): { id: string; name: string }[] {
  return Array.isArray(value)
    ? value.filter(
        (x: unknown): x is { id: string; name: string } =>
          typeof x === "object" &&
          x !== null &&
          typeof (x as Record<string, unknown>).id === "string",
      )
    : [];
}

function readLegacyRootId(config: Record<string, unknown>): string | null {
  const raw = config.rootFolderId;
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

function readLegacyRootName(config: Record<string, unknown>): string {
  const raw = config.rootFolderName;
  return typeof raw === "string" && raw.trim() !== ""
    ? raw.trim()
    : MY_DRIVE_TAB;
}

interface UseDriveInitParams {
  accessToken: string | null;
  isLoggedIn: boolean;
  hydratedRef: RefObject<boolean>;
}

export const useDriveInit = ({
  accessToken,
  isLoggedIn,
  hydratedRef,
}: UseDriveInitParams) => {
  const {
    setAppRootFolder,
    setRootFolders,
    setCurrentFolderId,
    setCurrentFolderName,
    setFolderHistory,
    setSortOption,
    setIsHydrated,
  } = useDriveStore(
    useShallow((state) => ({
      setAppRootFolder: state.setAppRootFolder,
      setRootFolders: state.setRootFolders,
      setCurrentFolderId: state.setCurrentFolderId,
      setCurrentFolderName: state.setCurrentFolderName,
      setFolderHistory: state.setFolderHistory,
      setSortOption: state.setSortOption,
      setIsHydrated: state.setIsHydrated,
    })),
  );

  // P2-04-8: tracks whether the PREVIOUS effect run was for an active login
  // session, so a logged-out -> logged-in transition can be told apart from a
  // mid-session re-init (token rotation).
  const sessionActiveRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const isCancelled = () => cancelled;

    // B12-1: a re-init is a re-run on an already-hydrated mount (typically the
    // ~45' proactive token rotation). It must not re-gate nav persistence nor
    // re-apply the persisted nav snapshot: the user may have navigated while
    // the re-verify is in flight, and overwriting that would revert their
    // position (the gated window would also silently drop their saves).
    const isReInit = hydratedRef.current;
    if (!isReInit) {
      hydratedRef.current = false;
    }

    // P2-04-8: a NEW login session starts with isHydrated=false so the folder
    // gate waits for THIS run instead of reading appRootFolder=null (the
    // initial placeholder) as "no root configured". A mid-session re-init
    // (token rotation, B12-1) must NOT reset it: the previous root is kept, so
    // blanking the flag would only risk a gate blink on a no-root screen.
    const sessionActive = isLoggedIn && accessToken !== null;
    if (sessionActive && !sessionActiveRef.current) {
      setIsHydrated(false);
    }
    sessionActiveRef.current = sessionActive;

    // One snapshot read of the ordered list + legacy primary. logMalformed is
    // only true for the initial read: the race guard re-reads this on every
    // await boundary and must not spam the log.
    const readLocalRootState = (logMalformed: boolean) => {
      const rawList = safeLocalStorageGet(
        ROOT_FOLDERS_KEY,
        "root-folders-read",
      );
      let list: RootFolder[] | null = null;
      if (rawList !== null) {
        try {
          list = parseRootFolders(JSON.parse(rawList));
          if (list === null && logMalformed) {
            void captureError({
              level: "warn",
              source: "useDrive",
              message:
                "root-folders-parse: invalid localStorage root folder list",
            });
          }
        } catch (e: unknown) {
          list = null;
          if (logMalformed) {
            void captureError({
              level: "warn",
              source: "useDrive",
              message: `root-folders-parse: corrupt localStorage root folder list, ${classifyError(e)}`,
            });
          }
        }
      }
      const primary = safeLocalStorageGet(ROOT_FOLDER_KEY, "root-folder-read");
      const roots =
        list ?? (primary ? [{ id: primary, name: MY_DRIVE_TAB }] : []);
      return {
        roots,
        primary,
        signature: `${rootsSignature(roots)}|${primary ?? ""}`,
      };
    };

    const initApp = async () => {
      // Outer try/finally guarantees hydration always reaches a safe state.
      // Even if initApp throws unexpectedly, the `finally` flips hydratedRef
      // true (unless the effect was cleaned up) so the nav-state save effect is
      // never permanently disabled. Without this, a rejected initApp would leave
      // hydratedRef.current=false forever and the app would silently stop
      // persisting navigation state.
      try {
        const savedSort = safeLocalStorageGet(
          SORT_OPTION_KEY,
          "sort-option-read",
        );
        if (savedSort) {
          setSortOption(savedSort);
        }

        // B12-3 (extended to the whole ordered list): snapshot the stored
        // roots + legacy primary before the first await. The user can commit a
        // new root list while this init is in flight; any later signature
        // mismatch means THIS run's remote config is stale and the user's
        // choice wins (no adopt, no LS write, no wipe, no nav restore).
        const localStateAtStart = readLocalRootState(true);
        const localRoots = localStateAtStart.roots;
        // Local commit marker (epoch ms): when it is NEWER than the remote
        // updatedAt, the local list is a commit whose cloud save has not landed
        // yet (or failed) and must win over the stale remote config.
        const localUpdatedAtRaw = safeLocalStorageGet(
          ROOT_FOLDERS_UPDATED_KEY,
          "root-folders-updated-read",
        );
        const parsedLocalUpdatedAt =
          localUpdatedAtRaw === null ? Number.NaN : Number(localUpdatedAtRaw);
        const localUpdatedAt = Number.isFinite(parsedLocalUpdatedAt)
          ? parsedLocalUpdatedAt
          : 0;
        // Rebased after this run writes its own LS snapshot, so the guard only
        // reports changes made by the USER, not by our persist step.
        let expectedSignature = localStateAtStart.signature;
        const rootChangedByUser = () =>
          readLocalRootState(false).signature !== expectedSignature;

        // B12-5: set when this run's remote roots differ from the stored ones
        // — the cached listing is invalidated below and the persisted nav
        // snapshot (which points inside the OLD roots) must be discarded.
        let rootChanged = false;
        let roots: RootFolder[] = localRoots;

        if (isLoggedIn && accessToken) {
          try {
            const freshToken = await getValidToken();
            if (isCancelled()) return;
            if (rootChangedByUser()) return;
            if (freshToken) {
              const remoteConfig = await getAppConfig(
                freshToken,
                controller.signal,
              );
              if (isCancelled()) return;
              if (rootChangedByUser()) return;

              // Cloud list is canonical when valid; otherwise migrate the
              // legacy single root. A missing remote config keeps whatever is
              // stored locally.
              const remoteUpdatedAt =
                remoteConfig !== null &&
                typeof remoteConfig.updatedAt === "number" &&
                Number.isFinite(remoteConfig.updatedAt)
                  ? remoteConfig.updatedAt
                  : 0;
              const localIsNewer =
                localRoots.length > 0 && localUpdatedAt > remoteUpdatedAt;
              const localIsNewerThanLegacy =
                localRoots.length > 0 && localUpdatedAt > 0;
              let proposed: RootFolder[];
              if (remoteConfig === null) {
                proposed = localRoots;
              } else if (remoteConfig.rootFolders !== undefined) {
                const remoteRoots = parseRootFolders(remoteConfig.rootFolders);
                if (remoteRoots !== null) {
                  if (localIsNewer) {
                    // GAP-3: this install committed after the remote config was
                    // written (or its cloud save never landed). The stale remote
                    // list — and its possibly-stale legacy primary — must not
                    // overwrite the user's newer local choice.
                    proposed = localRoots;
                  } else {
                    proposed = remoteRoots;
                    const remotePrimary = remoteRoots[0];
                    if (
                      remotePrimary !== undefined &&
                      remoteConfig.rootFolderId !== remotePrimary.id
                    ) {
                      // Every writer keeps the legacy scalar in sync with index
                      // 0; a mismatch means the scalar is stale, so the list
                      // wins and its first entry remains the primary.
                      void captureError({
                        level: "warn",
                        source: "useDrive",
                        message:
                          "config-primary-mismatch: using rootFolders[0]",
                      });
                    }
                  }
                } else {
                  void captureError({
                    level: "warn",
                    source: "useDrive",
                    message:
                      "config-root-folders-invalid: falling back to the legacy root id",
                  });
                  const legacyId = readLegacyRootId(remoteConfig);
                  proposed = legacyId
                    ? [{ id: legacyId, name: readLegacyRootName(remoteConfig) }]
                    : localRoots;
                }
              } else if (localIsNewerThanLegacy) {
                // A commit on this install is newer than a legacy-only remote
                // document: keep the local list instead of migrating backwards.
                proposed = localRoots;
              } else {
                const legacyId = readLegacyRootId(remoteConfig);
                proposed = legacyId
                  ? [{ id: legacyId, name: readLegacyRootName(remoteConfig) }]
                  : localRoots;
              }

              rootChanged =
                rootsSignature(proposed) !== rootsSignature(localRoots);

              // Verify EVERY root in order (all-or-nothing). A single bad
              // entry must not silently adopt a partial list: only the
              // verified primary may survive as the fallback.
              const verified: RootFolder[] = [];
              const invalidIds: string[] = [];
              // A transient failure (network/timeout/5xx) must never
              // invalidate a stored configuration: first-init keeps the local
              // roots instead of flashing the setup gate, and a re-init keeps
              // the live ones. 4xx and shape errors stay definitive.
              let transientFailure = false;
              // Set only when verification DEFINITIVELY dropped a root (never
              // on a transient failure): the reduced list may need persisting.
              let partialFallback = false;
              for (const root of proposed) {
                const verifyUrl = `${DRIVE_FILES_URL}/${encodeURIComponent(root.id)}?fields=${VERIFY_FIELDS}`;
                let verifyRes: Response;
                try {
                  verifyRes = await fetchWithAuth(verifyUrl, {
                    headers: authHeaders(freshToken),
                    // Timeout is guaranteed by fetchWithAuth itself (15s
                    // default merged with the caller signal via
                    // AbortSignal.any).
                    signal: controller.signal,
                  });
                } catch (e: unknown) {
                  // Effect cleanup aborts the request: expected, not a fault.
                  if (isCancelled()) return;
                  if (rootChangedByUser()) return;
                  if (isReInit && !rootChanged) {
                    void captureError({
                      level: "warn",
                      source: "useDrive",
                      message: `reverify-transient: keeping previous roots (${classifyError(e)})`,
                    });
                    return;
                  }
                  roots = localRoots;
                  rootChanged = false;
                  transientFailure = true;
                  void captureError({
                    level: "warn",
                    source: "useDrive",
                    message: `verify-roots-transient: keeping stored roots (${classifyError(e)})`,
                  });
                  break;
                }
                if (isCancelled()) return;
                if (rootChangedByUser()) return;
                if (!verifyRes.ok) {
                  if (verifyRes.status >= 500) {
                    if (isReInit && !rootChanged) {
                      // B12-1: a transient (5xx) re-verify failure during a
                      // token rotation keeps the previous roots — nulling
                      // them would open the folder gate mid-session.
                      void captureError({
                        level: "warn",
                        source: "useDrive",
                        message: `reverify-transient: keeping previous roots (HTTP ${String(verifyRes.status)})`,
                      });
                      return;
                    }
                    roots = localRoots;
                    rootChanged = false;
                    transientFailure = true;
                    void captureError({
                      level: "warn",
                      source: "useDrive",
                      message: `verify-roots-transient: keeping stored roots (HTTP ${String(verifyRes.status)})`,
                    });
                    break;
                  }
                  void captureError({
                    level: "warn",
                    source: "useDrive",
                    message: `verify-root-inaccessible: dropping root ${root.id}`,
                  });
                  invalidIds.push(root.id);
                  continue;
                }
                let verifyData: unknown;
                try {
                  verifyData = await verifyRes.json();
                } catch (e: unknown) {
                  void captureError({
                    level: "warn",
                    source: "useDrive",
                    message: `verify-root-parse: dropping root ${root.id}, ${classifyError(e)}`,
                  });
                  invalidIds.push(root.id);
                  continue;
                }
                if (isCancelled()) return;
                if (rootChangedByUser()) return;
                if (
                  typeof verifyData !== "object" ||
                  verifyData === null ||
                  (verifyData as { mimeType?: unknown }).mimeType !==
                    FOLDER_MIME
                ) {
                  void captureError({
                    level: "warn",
                    source: "useDrive",
                    message: `verify-root-not-folder: dropping root ${root.id}`,
                  });
                  invalidIds.push(root.id);
                  continue;
                }
                const folder = verifyData as {
                  name?: unknown;
                  driveId?: unknown;
                };
                if (folder.driveId) {
                  void captureError({
                    level: "warn",
                    source: "useDrive",
                    message: `verify-root-shared-drive: dropping root ${root.id}`,
                  });
                  invalidIds.push(root.id);
                  continue;
                }
                const rawName = folder.name;
                const verifiedName =
                  typeof rawName === "string" && rawName.trim() !== ""
                    ? rawName.trim()
                    : root.name;
                verified.push({ id: root.id, name: verifiedName });
              }

              if (!transientFailure) {
                if (verified.length === proposed.length) {
                  roots = verified;
                } else {
                  partialFallback = true;
                  const verifiedPrimary = verified[0];
                  const proposedPrimary = proposed[0];
                  if (
                    verifiedPrimary !== undefined &&
                    proposedPrimary !== undefined &&
                    verifiedPrimary.id === proposedPrimary.id
                  ) {
                    // All-or-nothing fallback: keep exactly the verified
                    // primary.
                    roots = [verifiedPrimary];
                    void captureError({
                      level: "warn",
                      source: "useDrive",
                      message: `verify-roots-partial: keeping primary, dropping [${invalidIds.join(", ")}]`,
                    });
                  } else {
                    roots = [];
                  }
                }

                // Final decision AFTER verification: a dropped secondary can
                // reduce the remote proposal back to the stored list, in which
                // case the cache wipe/nav reset must NOT run.
                const finalChanged =
                  rootsSignature(roots) !== rootsSignature(localRoots);
                rootChanged = finalChanged;
                if (!finalChanged && partialFallback) {
                  const verifiedPrimaryRoot = roots[0];
                  if (verifiedPrimaryRoot !== undefined) {
                    // Re-check right before writing: a user commit may have
                    // landed since the last in-loop check.
                    if (isCancelled()) return;
                    if (rootChangedByUser()) return;
                    // GAP-2: persist the reduced verified list locally so the
                    // next boot prefers it instead of re-verifying and dropping
                    // the same root forever. NO cloud write: a possibly
                    // transient 403 must not destroy a valid remote config.
                    safeLocalStorageSet(
                      ROOT_FOLDER_KEY,
                      verifiedPrimaryRoot.id,
                      "root-folder-write",
                    );
                    safeLocalStorageSet(
                      ROOT_FOLDERS_KEY,
                      JSON.stringify(roots),
                      "root-folders-write",
                    );
                    safeLocalStorageSet(
                      ROOT_FOLDERS_UPDATED_KEY,
                      String(Date.now()),
                      "root-folders-updated-write",
                    );
                    void captureError({
                      level: "warn",
                      source: "useDrive",
                      message: `verify-roots-partial-persist: keeping verified roots locally, dropping [${invalidIds.join(", ")}]`,
                    });
                  }
                }
              }
            } else {
              roots = [];
            }
          } catch (e: unknown) {
            if (isCancelled()) return;
            if (isReInit && !rootChanged) {
              // B12-1: a transient failure (network/timeout) during a re-init
              // with unchanged roots must keep the previous roots instead of
              // opening the folder gate mid-session.
              void captureError({
                level: "warn",
                source: "useDrive",
                message: `reverify-transient: keeping previous roots (${classifyError(e)})`,
              });
              return;
            }
            void captureError({
              level: "error",
              source: "useDrive",
              message: `sync-config-failed: ${classifyError(e)}`,
            });
            roots = [];
          }
        }

        if (isCancelled()) return;

        if (roots.length > 0) {
          const primaryRoot = roots[0];
          if (primaryRoot === undefined) {
            setAppRootFolder(null);
            setRootFolders([]);
            return;
          }
          const primaryId = primaryRoot.id;
          const isMulti = roots.length > 1;
          setRootFolders(roots);
          setAppRootFolder(primaryId);

          const fallbackToRoot = () => {
            setCurrentFolderId(isMulti ? VIRTUAL_ROOT_ID : primaryId);
            setCurrentFolderName(isMulti ? VIRTUAL_ROOT_NAME : MY_DRIVE_TAB);
          };

          const activeRootIds = new Set(roots.map((root) => root.id));
          const isActiveRoot = (id: string) => activeRootIds.has(id);

          // At the virtual node the trail may only reference the synthetic
          // node or roots that are still configured: a removed root id would
          // render a path outside the active root set. A virtual marker below
          // another entry (or repeated) cannot describe a real trail.
          const sanitizeVirtualHistory = (
            history: { id: string; name: string }[],
          ) => {
            const kept = history.filter(
              (entry) =>
                entry.id === VIRTUAL_ROOT_ID || activeRootIds.has(entry.id),
            );
            const firstVirtual = kept.findIndex(
              (entry) => entry.id === VIRTUAL_ROOT_ID,
            );
            const duplicateVirtual =
              kept.filter((entry) => entry.id === VIRTUAL_ROOT_ID).length > 1;
            return duplicateVirtual || firstVirtual > 0 ? [] : kept;
          };

          // Keeps only the part of the trail at or below the branch marker:
          // the virtual node when present, otherwise the branch root itself.
          // No marker means the trail cannot be attributed to this branch.
          const trimHistoryToBranch = (
            history: { id: string; name: string }[],
            branchRootId: string | null,
          ) => {
            const virtualIndex = history.findIndex(
              (entry) => entry.id === VIRTUAL_ROOT_ID,
            );
            if (virtualIndex !== -1) return history.slice(virtualIndex);
            if (branchRootId !== null) {
              const branchIndex = history.findIndex(
                (entry) => entry.id === branchRootId,
              );
              if (branchIndex !== -1) return history.slice(branchIndex);
            }
            return [];
          };

          const verifiedRootName = (rootId: string) =>
            roots.find((root) => root.id === rootId)?.name;

          const applyRestoredNav = (
            savedId: string,
            savedName: string,
            savedHistory: { id: string; name: string }[],
            savedRootId?: string,
          ) => {
            if (savedId === VIRTUAL_ROOT_ID) {
              if (isMulti) {
                setCurrentFolderId(VIRTUAL_ROOT_ID);
                setCurrentFolderName(VIRTUAL_ROOT_NAME);
                setFolderHistory(sanitizeVirtualHistory(savedHistory));
              } else {
                // The synthetic node only exists while at least 2 roots are
                // configured.
                fallbackToRoot();
                setFolderHistory([]);
              }
              return;
            }
            const suspectRoot =
              savedId === ROOT_FOLDER_ID && primaryId !== ROOT_FOLDER_ID;
            if (suspectRoot) {
              fallbackToRoot();
              setFolderHistory([]);
              return;
            }

            if (isMulti) {
              const savedIdIsRoot = isActiveRoot(savedId);
              if (savedRootId === undefined) {
                // Legacy snapshot: a nested id cannot be attributed to any
                // branch of the active root set.
                if (!savedIdIsRoot) {
                  fallbackToRoot();
                  setFolderHistory([]);
                  return;
                }
                setCurrentFolderId(savedId);
                setCurrentFolderName(verifiedRootName(savedId) ?? savedName);
                setFolderHistory(trimHistoryToBranch(savedHistory, savedId));
                return;
              }
              const validSavedRoot =
                savedRootId === VIRTUAL_ROOT_ID || isActiveRoot(savedRootId);
              if (
                !validSavedRoot ||
                (savedIdIsRoot && savedId !== savedRootId)
              ) {
                fallbackToRoot();
                setFolderHistory([]);
                return;
              }
              setCurrentFolderId(savedId);
              setCurrentFolderName(
                savedIdIsRoot
                  ? (verifiedRootName(savedId) ?? savedName)
                  : savedName,
              );
              setFolderHistory(
                trimHistoryToBranch(
                  savedHistory,
                  savedRootId === VIRTUAL_ROOT_ID ? null : savedRootId,
                ),
              );
              return;
            }

            // Single root: a real root id must match this root; the virtual
            // node is invalid because it only exists in multi-root mode.
            if (savedRootId !== undefined && savedRootId !== primaryId) {
              fallbackToRoot();
              setFolderHistory([]);
              return;
            }
            setCurrentFolderId(savedId);
            setCurrentFolderName(
              savedId === primaryId || savedId === ROOT_FOLDER_ID
                ? MY_DRIVE_TAB
                : savedName,
            );
            setFolderHistory(
              savedHistory.filter((entry) => entry.id !== VIRTUAL_ROOT_ID),
            );
          };

          // B12-5: the configured roots changed in this run — the cached
          // listing was just invalidated and the persisted nav snapshot points
          // inside the OLD roots (out of the new scope). Land on the new root
          // instead of resuming a stale folder.
          if (rootChanged) {
            // The last in-loop check ran before the remote roots were applied;
            // a user commit landing since then must win over these writes.
            if (rootChangedByUser()) return;
            safeLocalStorageSet(
              ROOT_FOLDER_KEY,
              primaryId,
              "root-folder-write",
            );
            safeLocalStorageSet(
              ROOT_FOLDERS_KEY,
              JSON.stringify(roots),
              "root-folders-write",
            );
            safeLocalStorageSet(
              ROOT_FOLDERS_UPDATED_KEY,
              String(Date.now()),
              "root-folders-updated-write",
            );
            expectedSignature = readLocalRootState(false).signature;
            // Invalidate the local listing only when the configured roots
            // actually changed. initApp also re-runs on a plain proactive
            // token refresh; wiping db.files then would blank the My Drive UI
            // until the next folder fetch.
            try {
              const email = getCurrentUserEmail();
              if (email === DEFAULT_USER_EMAIL) {
                // Sentinel owner (no real account email known yet): legacy
                // rows have no account fingerprint to scope by — keep the
                // store-wide clear.
                await db.files.clear();
              } else {
                // Account-scoped invalidation (schema v10 scoping): a
                // store-wide clear would destroy every OTHER account's mirror
                // too.
                await wipeFileRowsForUser(email);
              }
              await invoke(CLEAR_LOCAL_CACHE_CMD);
            } catch (e: unknown) {
              void captureError({
                level: "warn",
                source: "useDrive",
                message: `clear-cache-failed: ${classifyError(e)}`,
              });
            }
            if (isCancelled()) return;
            if (rootChangedByUser()) return;
            fallbackToRoot();
            setFolderHistory([]);
            return;
          }
          if (isReInit) {
            // B12-1: token-rotation re-verify with unchanged roots — leave
            // the live nav state alone. Re-applying the persisted snapshot
            // would revert navigation made while the re-verify was in flight.
            return;
          }

          try {
            const state = await db.syncState.get(DB_NAV_STATE_KEY);
            if (isCancelled()) return;
            if (rootChangedByUser()) return;
            if (state && state.value) {
              const raw = state.value;
              if (typeof raw === "object" && "id" in raw) {
                const obj = raw as Record<string, unknown>;
                if (typeof obj.id === "string") {
                  applyRestoredNav(
                    obj.id,
                    typeof obj.name === "string" ? obj.name : MY_DRIVE_TAB,
                    parseNavHistory(obj.history),
                    typeof obj.rootId === "string" ? obj.rootId : undefined,
                  );
                } else {
                  fallbackToRoot();
                }
              } else {
                fallbackToRoot();
              }
            } else {
              const savedCurrentId = safeLocalStorageGet(
                CURRENT_FOLDER_ID_KEY,
                "current-folder-id-read",
              );
              const savedCurrentName = safeLocalStorageGet(
                CURRENT_FOLDER_NAME_KEY,
                "current-folder-name-read",
              );
              const savedHistoryStr = safeLocalStorageGet(
                FOLDER_HISTORY_KEY,
                "folder-history-read",
              );

              if (savedCurrentId && savedCurrentName && savedHistoryStr) {
                let history: { id: string; name: string }[];
                try {
                  history = parseNavHistory(JSON.parse(savedHistoryStr));
                } catch (e: unknown) {
                  void captureError({
                    level: "warn",
                    source: "useDrive",
                    message: `nav-state-parse: corrupt localStorage folder history, ${classifyError(e)}`,
                  });
                  history = [];
                }
                applyRestoredNav(savedCurrentId, savedCurrentName, history);
              } else {
                fallbackToRoot();
              }
            }
          } catch (e: unknown) {
            if (isCancelled()) return;
            void captureError({
              level: "warn",
              source: "useDrive",
              message: `nav-state-restore-failed: ${classifyError(e)}`,
            });
            fallbackToRoot();
          }
        } else {
          setAppRootFolder(null);
          setRootFolders([]);
        }
      } catch (e: unknown) {
        // Unexpected throw from initApp (e.g. an unhandled rejection). Fall back
        // to a safe state so the app is not stuck without an app root folder and
        // hydration still completes in the finally below.
        if (isCancelled()) return;
        void captureError({
          level: "error",
          source: "useDrive",
          message: `init-app-unexpected: ${classifyError(e)}`,
        });
        setAppRootFolder(null);
        setRootFolders([]);
      } finally {
        // Hydration safety: always flip to true unless the effect was cleaned up
        // (unmount / dependency change). If cancelled, a fresh effect run will
        // re-init with hydratedRef reset to false, so we must NOT hydrate here.
        // isHydrated rides the same guard: the cancelled run must not claim
        // the new session is settled before its own verify lands.
        if (!cancelled) {
          hydratedRef.current = true;
          setIsHydrated(true);
        }
      }
    };

    // Defensive net: initApp's own try/finally already guarantees hydration, but
    // this catch logs any rejection that escapes initApp instead of swallowing it.
    initApp().catch(
      (e: unknown) =>
        void captureError({
          level: "error",
          source: "useDrive",
          message: `init-app-failed: ${classifyError(e)}`,
        }),
    );

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    isLoggedIn,
    accessToken,
    setSortOption,
    setAppRootFolder,
    setRootFolders,
    setCurrentFolderId,
    setCurrentFolderName,
    setFolderHistory,
    setIsHydrated,
  ]);
};
