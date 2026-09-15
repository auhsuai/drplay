import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getTrashedFiles } from "../../utils/drivePagination";
import { showErrorToast } from "../../utils/simpleToast";
import { captureError } from "../../utils/errorLog";
import { describeError, TRASH_MODULE } from "./trashBulkOps";

export interface TrashedItem {
  id: string;
  name: string;
  mimeType: string;
}

export function useTrashedFiles(token: string) {
  const { t } = useTranslation();
  const [items, setItems] = useState<TrashedItem[]>([]);
  // Loading starts TRUE so the first committed frame shows the skeleton —
  // starting false flashed the "Trash is empty" state for one frame before
  // the effect set loading on (RC-B).
  const [isLoading, setIsLoading] = useState(true);

  const fetchTrashed = async (signal?: AbortSignal) => {
    try {
      // Fetch trashed audio files and folders that were deleted by DrPlay
      const q =
        "trashed=true and appProperties has { key='deletedByDrPlay' and value='true' }";
      const files = await getTrashedFiles(token, q, signal);
      // Ignore flag: a response from a superseded token (or an aborted
      // fetch) must not overwrite the current account's list.
      if (signal?.aborted) return;
      setItems(
        files.map((f: TrashedItem) => ({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
        })),
      );
    } catch (e) {
      // Cancellation is not a failure — no log, no toast.
      if (signal?.aborted) return;
      void captureError({
        level: "error",
        source: TRASH_MODULE,
        message: `fetch-trashed-failed: ${describeError(e)}`,
      });
      showErrorToast(t("settings.trash_load_error"));
    } finally {
      if (!signal?.aborted) setIsLoading(false);
    }
  };

  useEffect(() => {
    // Abort the in-flight fetch on token change/unmount so a stale response
    // cannot land on the new account (and no state is set after unmount).
    const controller = new AbortController();
    // Reset loading first so the previous account's list is not shown while
    // the new fetch is in flight.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    // Kick off the fetch; every state update inside it happens after await.
    void fetchTrashed(controller.signal);
    return () => {
      controller.abort();
    };
    // fetchTrashed only closes over token (already in deps); its identity
    // changes every render but the effect must only run on token change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return { items, setItems, isLoading, setIsLoading };
}
