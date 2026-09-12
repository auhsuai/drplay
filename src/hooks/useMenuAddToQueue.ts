import { useEffect, useRef, useState } from "react";
import type { Track, DriveItem } from "../types";
import type { TFunction } from "i18next";
import { appendTracksToQueue } from "../store/queueOps";
import {
  collectFolderTracks,
  MAX_ADD_TO_QUEUE_TRACKS,
} from "../utils/folderTracks";
import { showErrorToast, showSuccessToast } from "../utils/simpleToast";
import { captureError } from "../utils/errorLog";
import { isAbortError } from "./player/utils";

/**
 * "Add to queue" menu action: a file appends one track, a folder walks its
 * whole subtree (recursively) and appends every playable audio file found.
 * The folder walk is abortable (unmount) and guarded against a second click
 * while it is still running.
 */
export function useMenuAddToQueue(t: TFunction): {
  isAddingToQueue: boolean;
  handleAddToQueueClick: (
    e: React.MouseEvent,
    driveItem: DriveItem | undefined,
    track: Track | undefined,
    token: string | null | undefined,
    setIsOpen: (o: boolean) => void,
    onClose?: () => void,
  ) => void;
} {
  const [isAddingToQueue, setIsAddingToQueue] = useState(false);
  // Sync busy-guard: two clicks in the same tick both read the state as stale
  // false, so only the ref stops a second folder walk (same pattern as
  // useMenuDownload's isDownloadingRef).
  const isAddingToQueueRef = useRef(false);
  // Abort the in-flight walk on unmount — a large tree must stop issuing
  // Drive requests once its menu owner is gone.
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  const handleAddToQueueClick = (
    e: React.MouseEvent,
    driveItem: DriveItem | undefined,
    track: Track | undefined,
    token: string | null | undefined,
    setIsOpen: (o: boolean) => void,
    onClose?: () => void,
  ) => {
    e.stopPropagation();

    if (driveItem?.isFolder !== true) {
      if (!track) return;
      setIsOpen(false);
      onClose?.();
      appendTracksToQueue([track]);
      showSuccessToast(t("queue.added_toast", { count: 1 }));
      return;
    }

    if (!token || isAddingToQueueRef.current) return;
    isAddingToQueueRef.current = true;
    setIsAddingToQueue(true);
    setIsOpen(false);
    onClose?.();

    const controller = new AbortController();
    abortControllerRef.current = controller;
    const folderToken: string = token;
    const { id: folderId, title: folderName } = driveItem;

    void (async () => {
      try {
        const { tracks, truncated } = await collectFolderTracks(
          folderToken,
          folderId,
          folderName,
          controller.signal,
        );
        // The walk may resolve with partial data after an abort — never treat
        // that as a completed add.
        if (controller.signal.aborted) return;
        if (tracks.length === 0) {
          showErrorToast(t("queue.add_empty"));
          return;
        }
        appendTracksToQueue(tracks);
        showSuccessToast(t("queue.added_toast", { count: tracks.length }));
        if (truncated) {
          showErrorToast(
            t("queue.add_truncated", { count: MAX_ADD_TO_QUEUE_TRACKS }),
          );
        }
      } catch (err: unknown) {
        if (isAbortError(err)) return;
        void captureError({
          level: "warn",
          source: "useMenuAddToQueue",
          message: `add-to-queue-failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        showErrorToast(t("queue.add_failed"));
      } finally {
        isAddingToQueueRef.current = false;
        // After unmount the state does not exist anymore — skip the update.
        if (!controller.signal.aborted) setIsAddingToQueue(false);
      }
    })();
  };

  return { isAddingToQueue, handleAddToQueueClick };
}
