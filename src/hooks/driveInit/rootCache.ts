import { invoke } from "@tauri-apps/api/core";
import { db } from "../../db/db";
import { wipeFileRowsForUser } from "../../db/fileRows";
import type { RootFolder } from "../../utils/rootFolders";
import { captureError } from "../../utils/errorLog";
import {
  DEFAULT_USER_EMAIL,
  getCurrentUserEmail,
  ROOT_FOLDER_KEY,
  ROOT_FOLDERS_KEY,
  ROOT_FOLDERS_UPDATED_KEY,
  safeLocalStorageSet,
} from "../../utils/storageKeys";
import { CLEAR_LOCAL_CACHE_CMD } from "../../utils/cache";
import { classifyError } from "../useDriveShared";

// Invalidate the local listing only when the configured roots actually
// changed. initApp also re-runs on a plain proactive token refresh; wiping
// db.files then would blank the My Drive UI until the next folder fetch.
//
// Account scoping matters here: a store-wide clear would destroy every OTHER
// account's mirror too, so only the sentinel owner (no real email known yet,
// whose legacy rows carry no account fingerprint) gets `db.files.clear()`.
// Never throws — failures are reported as `clear-cache-failed`.
export async function invalidateListingCacheForCurrentAccount(): Promise<void> {
  try {
    const email = getCurrentUserEmail();
    if (email === DEFAULT_USER_EMAIL) {
      await db.files.clear();
    } else {
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

// Persist the committed root list locally (primary scalar + ordered list +
// commit marker). Written in this exact order: the marker must reflect the
// write that just landed.
export function persistRootListLocally(
  primaryId: string,
  roots: RootFolder[],
): void {
  safeLocalStorageSet(ROOT_FOLDER_KEY, primaryId, "root-folder-write");
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
}
