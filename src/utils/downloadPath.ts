import { appDataDir, downloadDir } from "@tauri-apps/api/path";
import { captureError } from "./errorLog";
import { IS_MOBILE } from "./platform";

const STORAGE_KEY = "drplay_download_path";

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

export async function getEffectiveDownloadPath(): Promise<string> {
  // Mobile downloads land in the app's private storage: always writable
  // without storage permissions, unlike $DOWNLOAD on Android 10+ scoped
  // storage. The download flow extends the fs scope to this dir at write
  // time (useMenuDownload).
  if (IS_MOBILE) return appDataDir();
  const custom = getCustomDownloadPath();
  if (custom) return custom;
  return downloadDir();
}
