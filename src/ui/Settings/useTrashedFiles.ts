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

  const fetchTrashed = async () => {
    try {
      // Fetch trashed audio files and folders that were deleted by DrPlay
      const q =
        "trashed=true and appProperties has { key='deletedByDrPlay' and value='true' }";
      const files = await getTrashedFiles(token, q);
      setItems(
        files.map((f: TrashedItem) => ({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
        })),
      );
    } catch (e) {
      void captureError({
        level: "error",
        source: TRASH_MODULE,
        message: `fetch-trashed-failed: ${describeError(e)}`,
      });
      showErrorToast(t("settings.trash_load_error"));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    // fetchTrashed only sets state after await, but the React Compiler
    // lint rule (set-state-in-effect) still traces the finally-setState
    // through the try/catch exception edges, so the disable stays.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchTrashed();
    // fetchTrashed only closes over token (already in deps); its identity
    // changes every render but the effect must only run on token change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return { items, setItems, isLoading, setIsLoading, fetchTrashed };
}
