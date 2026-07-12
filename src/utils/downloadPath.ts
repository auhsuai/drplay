import { downloadDir, desktopDir } from "@tauri-apps/api/path";

const STORAGE_KEY = "drplay_download_path";
const SAFE_PREFIXES_KEY = "__drplay_safe_dirs";

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

async function getSafePrefixes(): Promise<string[]> {
  const cached = sessionStorage.getItem(SAFE_PREFIXES_KEY);
  if (cached) return JSON.parse(cached);
  const prefixes = await Promise.all([
    downloadDir(),
    desktopDir(),
  ]);
  sessionStorage.setItem(SAFE_PREFIXES_KEY, JSON.stringify(prefixes));
  return prefixes;
}

export async function isSafeDownloadPath(path: string): Promise<boolean> {
  try {
    if (path.includes('..') || path.includes('./')) return false;
    const prefixes = await getSafePrefixes();
    const normalized = path.replace(/\\/g, '/').toLowerCase();
    return prefixes.some(p => normalized.startsWith(p.replace(/\\/g, '/').toLowerCase()));
  } catch { return false; }
}