import { appDataDir, downloadDir } from "@tauri-apps/api/path";
import { captureError } from "./errorLog";
import { IS_MOBILE } from "./platform";

const STORAGE_KEY = "drplay_download_path";
// Mobile SAF folder (Task 4 mobile-polish): the user-picked Android folder is
// a content:// tree URI + display name, NOT a filesystem path — a separate
// key keeps it from ever being treated as a desktop-style absolute path.
const MOBILE_FOLDER_KEY = "drplay_mobile_download_folder";

/** Android SAF download folder: { uri, name } picked via the SAF picker. */
export interface MobileDownloadFolder {
  uri: string;
  name: string;
}

export function getCustomDownloadPath(): string | null {
  // Mobile never picks a folder: the custom path concept is desktop-only
  // (a stale value migrated from a desktop install must not redirect
  // downloads to a path that does not exist on the phone).
  if (IS_MOBILE) return null;
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch (err) {
    // fire-and-forget: logging must not throw in this sync path (captureError
    // never rejects — it swallows failures internally).
    void captureError({
      level: "warn",
      source: "downloadPath",
      message: `custom-path-read-failed:${err instanceof Error || err instanceof DOMException ? err.name : "unknown"}`,
    });
    return null;
  }
}

export function setCustomDownloadPath(path: string): void {
  // No-op on mobile: folder picking does not exist there, so nothing may be
  // persisted that would shadow the app-dir default.
  if (IS_MOBILE) return;
  try {
    localStorage.setItem(STORAGE_KEY, path);
  } catch (err) {
    // fire-and-forget: logging must not throw in this sync path (captureError
    // never rejects — it swallows failures internally).
    void captureError({
      level: "warn",
      source: "downloadPath",
      message: `custom-path-write-failed:${err instanceof Error || err instanceof DOMException ? err.name : "unknown"}`,
    });
  }
}

/**
 * Android SAF download folder (mobile only). Desktop always returns null —
 * the two folder concepts must never bleed into each other.
 */
export function getMobileDownloadFolder(): MobileDownloadFolder | null {
  if (!IS_MOBILE) return null;
  try {
    const raw = localStorage.getItem(MOBILE_FOLDER_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as MobileDownloadFolder).uri !== "string" ||
      typeof (parsed as MobileDownloadFolder).name !== "string"
    ) {
      return null;
    }
    return parsed as MobileDownloadFolder;
  } catch (err) {
    void captureError({
      level: "warn",
      source: "downloadPath",
      message: `mobile-folder-read-failed:${err instanceof Error || err instanceof DOMException ? err.name : "unknown"}`,
    });
    return null;
  }
}

/** Persist the Android SAF folder (mobile only); desktop is a no-op. */
export function setMobileDownloadFolder(folder: MobileDownloadFolder): void {
  if (!IS_MOBILE) return;
  try {
    localStorage.setItem(MOBILE_FOLDER_KEY, JSON.stringify(folder));
  } catch (err) {
    void captureError({
      level: "warn",
      source: "downloadPath",
      message: `mobile-folder-write-failed:${err instanceof Error || err instanceof DOMException ? err.name : "unknown"}`,
    });
  }
}

/** Clear the persisted Android SAF folder (mobile only); desktop no-op. */
export function clearMobileDownloadFolder(): void {
  if (!IS_MOBILE) return;
  try {
    localStorage.removeItem(MOBILE_FOLDER_KEY);
  } catch (err) {
    void captureError({
      level: "warn",
      source: "downloadPath",
      message: `mobile-folder-clear-failed:${err instanceof Error || err instanceof DOMException ? err.name : "unknown"}`,
    });
  }
}

export async function getEffectiveDownloadPath(): Promise<string> {
  // Mobile downloads land in the app's private storage: always writable
  // without storage permissions, unlike $DOWNLOAD on Android 10+ scoped
  // storage. The download flow extends the fs scope to this dir at write
  // time (useMenuDownload). A user-picked SAF folder does NOT change this —
  // the staged write still happens here and the SAF plugin then streams the
  // staged file into the picked content-URI tree.
  if (IS_MOBILE) return appDataDir();
  const custom = getCustomDownloadPath();
  if (custom) return custom;
  return downloadDir();
}
