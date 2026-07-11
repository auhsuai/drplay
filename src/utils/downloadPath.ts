import { downloadDir } from "@tauri-apps/api/path";

const STORAGE_KEY = "drplay_download_path";

export function getCustomDownloadPath(): string | null {
  return localStorage.getItem(STORAGE_KEY);
}

export function setCustomDownloadPath(path: string): void {
  localStorage.setItem(STORAGE_KEY, path);
}

export function clearCustomDownloadPath(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export async function getEffectiveDownloadPath(): Promise<string> {
  const custom = getCustomDownloadPath();
  if (custom) return custom;
  return await downloadDir();
}