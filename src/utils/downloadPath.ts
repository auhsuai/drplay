import { downloadDir } from "@tauri-apps/api/path";
import { captureError } from "./errorLog";

const STORAGE_KEY = "drplay_download_path";

export function getCustomDownloadPath(): string | null {
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
  const custom = getCustomDownloadPath();
  if (custom) return custom;
  return downloadDir();
}
