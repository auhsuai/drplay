import { useEffect, useState } from "react";
import { getEntries, subscribe } from "../../utils/uploadManager";
import type { UploadEntry } from "../../utils/uploadManager";

// Shown while a queued entry waits for its turn in the sequential upload queue.
const QUEUED_UPLOAD_LABEL = "Queued...";
// Upload progress is a 0..1 fraction; the UI renders it as a percentage.
const PROGRESS_PERCENT_SCALE = 100;

// The in-progress uploads section only lists live entries — terminal
// (done/error) entries are pruned by the manager right after they notify.
function isActiveUpload(entry: UploadEntry): boolean {
  return entry.status === "queued" || entry.status === "uploading";
}

export function uploadProgressLabel(entry: UploadEntry): string {
  if (entry.status === "uploading") {
    const percent = Math.round((entry.progress ?? 0) * PROGRESS_PERCENT_SCALE);
    return `${String(percent)}%`;
  }
  return QUEUED_UPLOAD_LABEL;
}

export function useActiveUploads(): UploadEntry[] {
  const [uploadEntries, setUploadEntries] = useState<UploadEntry[]>(getEntries);

  // Live snapshot of the upload queue: subscribe returns an unsubscribe, so
  // the effect's cleanup unsubscribes on unmount (no leaked subscriber).
  useEffect(() => {
    const unsubscribeFromUploads = subscribe(() => {
      setUploadEntries(getEntries());
    });
    return unsubscribeFromUploads;
  }, []);

  return uploadEntries.filter(isActiveUpload);
}
