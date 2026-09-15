import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { useShallow } from "zustand/react/shallow";
import { invoke } from "@tauri-apps/api/core";
import { db } from "../db/db";
import { wipeFileRowsForUser } from "../db/fileRows";
import { getAppConfig, FOLDER_MIME } from "../utils/driveApi";
import { getValidToken, fetchWithAuth } from "../utils/apiClient";
import { CLEAR_LOCAL_CACHE_CMD } from "../utils/cache";
import { ROOT_FOLDER_ID, MY_DRIVE_TAB } from "../utils/driveConstants";
import { authHeaders, DRIVE_FILES_URL } from "../utils/driveFiles";
import { useDriveStore } from "../store/driveStore";
import { captureError } from "../utils/errorLog";
import {
  DEFAULT_USER_EMAIL,
  getCurrentUserEmail,
  ROOT_FOLDER_KEY,
  CURRENT_FOLDER_ID_KEY,
  CURRENT_FOLDER_NAME_KEY,
  FOLDER_HISTORY_KEY,
  SORT_OPTION_KEY,
  DB_NAV_STATE_KEY,
  safeLocalStorageGet,
  safeLocalStorageSet,
} from "../utils/storageKeys";
import { classifyError } from "./useDriveShared";

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
    setCurrentFolderId,
    setCurrentFolderName,
    setFolderHistory,
    setSortOption,
    setIsHydrated,
  } = useDriveStore(
    useShallow((state) => ({
      setAppRootFolder: state.setAppRootFolder,
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

        let localRoot = safeLocalStorageGet(
          ROOT_FOLDER_KEY,
          "root-folder-read",
        );
        // B12-3: snapshot the stored root before the first await. The user can
        // pick a new root via handleSelectRootFolder (Settings -> Change
        // folder) while this init is in flight; any later mismatch on the key
        // means THIS run's remote config is stale and the user's choice wins
        // (no adopt, no LS write, no wipe, no nav restore).
        const lsRootAtStart = localRoot;
        const rootChangedByUser = () =>
          safeLocalStorageGet(ROOT_FOLDER_KEY, "root-folder-read") !==
          lsRootAtStart;
        // B12-5: set when this run's remote root differs from the stored root
        // — the cached listing is invalidated below and the persisted nav
        // snapshot (which points inside the OLD root) must be discarded.
        let rootChanged = false;

        if (isLoggedIn && accessToken) {
          try {
            const freshToken = await getValidToken();
            if (isCancelled()) return;
            if (freshToken) {
              const remoteConfig = await getAppConfig(
                freshToken,
                controller.signal,
              );
              if (isCancelled()) return;
              if (remoteConfig && remoteConfig.rootFolderId) {
                // B12-3: the user picked a root while getAppConfig was in
                // flight — their selection wins; abandon this run's
                // config/root decisions entirely.
                if (rootChangedByUser()) return;
                // The config id is a Drive file id (string) by contract; the
                // typeof guard keeps String() off a truthy-narrowed value.
                const rootIdRaw: unknown = remoteConfig.rootFolderId;
                const rootId =
                  typeof rootIdRaw === "string" ? rootIdRaw : String(rootIdRaw);
                if (rootId !== localRoot) {
                  rootChanged = true;
                  localRoot = rootId;
                }
                const verifyUrl = `${DRIVE_FILES_URL}/${localRoot}?fields=id,name,driveId,mimeType`;
                const verifyRes = await fetchWithAuth(verifyUrl, {
                  headers: authHeaders(freshToken),
                  // Timeout is guaranteed by fetchWithAuth itself (15s default
                  // merged with the caller signal via AbortSignal.any).
                  signal: controller.signal,
                });
                if (isCancelled()) return;
                if (!verifyRes.ok) {
                  if (verifyRes.status >= 500 && isReInit && !rootChanged) {
                    // B12-1: a transient (5xx) re-verify failure during a
                    // token rotation keeps the previous root — nulling it
                    // would open the folder gate mid-session.
                    void captureError({
                      level: "warn",
                      source: "useDrive",
                      message: `reverify-transient: keeping previous root (HTTP ${String(verifyRes.status)})`,
                    });
                  } else {
                    void captureError({
                      level: "warn",
                      source: "useDrive",
                      message:
                        "verify-root-inaccessible: saved root no longer accessible",
                    });
                    localRoot = null;
                  }
                } else {
                  const verifyData = (await verifyRes.json()) as {
                    mimeType?: unknown;
                    driveId?: unknown;
                  };
                  if (verifyData.mimeType !== FOLDER_MIME) {
                    void captureError({
                      level: "warn",
                      source: "useDrive",
                      message:
                        "verify-root-not-folder: saved root is not a folder",
                    });
                    localRoot = null;
                  } else if (verifyData.driveId) {
                    void captureError({
                      level: "warn",
                      source: "useDrive",
                      message:
                        "verify-root-shared-drive: saved root is a Shared Drive folder",
                    });
                    localRoot = null;
                  }
                }
                if (localRoot) {
                  const savedRoot = safeLocalStorageGet(
                    ROOT_FOLDER_KEY,
                    "root-folder-read",
                  );
                  // B12-3: the user picked a root during the verify await.
                  if (rootChangedByUser()) return;
                  if (remoteConfig.rootFolderId !== savedRoot) {
                    safeLocalStorageSet(
                      ROOT_FOLDER_KEY,
                      localRoot,
                      "root-folder-write",
                    );
                    // Invalidate the local listing only when the configured
                    // root actually changed. initApp also re-runs on a plain
                    // proactive token refresh; wiping db.files then would
                    // blank the My Drive UI until the next folder fetch.
                    try {
                      const email = getCurrentUserEmail();
                      if (email === DEFAULT_USER_EMAIL) {
                        // Sentinel owner (no real account email known yet):
                        // legacy rows have no account fingerprint to scope by —
                        // keep the store-wide clear.
                        await db.files.clear();
                      } else {
                        // Account-scoped invalidation (schema v10 scoping): a
                        // store-wide clear would destroy every OTHER account's
                        // mirror too.
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
                  }
                }
              } else if (!localRoot) {
                localRoot = null;
              }
            } else {
              localRoot = null;
            }
          } catch (e: unknown) {
            if (isCancelled()) return;
            if (isReInit && !rootChanged) {
              // B12-1: a transient failure (network/timeout) during a re-init
              // with an unchanged root must keep the previous root instead of
              // opening the folder gate mid-session.
              void captureError({
                level: "warn",
                source: "useDrive",
                message: `reverify-transient: keeping previous root (${classifyError(e)})`,
              });
            } else {
              void captureError({
                level: "error",
                source: "useDrive",
                message: `sync-config-failed: ${classifyError(e)}`,
              });
              localRoot = null;
            }
          }
        }

        if (isCancelled()) return;

        if (localRoot) {
          setAppRootFolder(localRoot);

          const fallbackToRoot = () => {
            setCurrentFolderId(localRoot);
            setCurrentFolderName(MY_DRIVE_TAB);
          };

          // B12-5: the configured root changed in this run — the cached
          // listing was just invalidated and the persisted nav snapshot
          // points inside the OLD root (out of the new app root's scope).
          // Land on the new root instead of resuming a stale folder.
          if (rootChanged) {
            fallbackToRoot();
            setFolderHistory([]);
            return;
          }
          if (isReInit) {
            // B12-1: token-rotation re-verify with an unchanged root — leave
            // the live nav state alone. Re-applying the persisted snapshot
            // would revert navigation made while the re-verify was in flight.
            return;
          }

          try {
            const state = await db.syncState.get(DB_NAV_STATE_KEY);
            if (isCancelled()) return;
            if (state && state.value) {
              const raw = state.value;
              if (typeof raw === "object" && "id" in raw) {
                const obj = raw as Record<string, unknown>;
                if (typeof obj.id === "string") {
                  const sv = {
                    id: obj.id,
                    name:
                      typeof obj.name === "string" ? obj.name : MY_DRIVE_TAB,
                    history: parseNavHistory(obj.history),
                  };
                  const savedId = sv.id;
                  const suspectRoot =
                    savedId === ROOT_FOLDER_ID && localRoot !== ROOT_FOLDER_ID;
                  const restoredId =
                    suspectRoot && localRoot ? localRoot : savedId;
                  setCurrentFolderId(restoredId);
                  setCurrentFolderName(
                    restoredId === localRoot || restoredId === ROOT_FOLDER_ID
                      ? MY_DRIVE_TAB
                      : sv.name,
                  );
                  setFolderHistory(suspectRoot ? [] : sv.history);
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
                setCurrentFolderId(savedCurrentId);
                setCurrentFolderName(
                  savedCurrentId === ROOT_FOLDER_ID
                    ? MY_DRIVE_TAB
                    : savedCurrentName,
                );
                try {
                  setFolderHistory(
                    parseNavHistory(JSON.parse(savedHistoryStr)),
                  );
                } catch (e: unknown) {
                  void captureError({
                    level: "warn",
                    source: "useDrive",
                    message: `nav-state-parse: corrupt localStorage folder history, ${classifyError(e)}`,
                  });
                  setFolderHistory([]);
                }
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
    setCurrentFolderId,
    setCurrentFolderName,
    setFolderHistory,
    setIsHydrated,
  ]);
};
