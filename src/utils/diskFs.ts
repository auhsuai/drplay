import { invoke } from '@tauri-apps/api/core';
import { captureError } from './errorLog';

// tauri-plugin-fs v2 command names, verified against the plugins-workspace v2
// guest-js (raw.githubusercontent.com/tauri-apps/plugins-workspace/v2/plugins/fs/guest-js/index.ts,
// fetched 2026-08-02). The repo does NOT use @tauri-apps/plugin-fs npm
// bindings — it invokes the plugin commands directly (same pattern as
// useMenuDownload.ts:121).
const FS_READ_FILE_CMD = 'plugin:fs|read_file';
const FS_READ_DIR_CMD = 'plugin:fs|read_dir';
const FS_STAT_CMD = 'plugin:fs|stat';

// Custom Rust command registered in src-tauri/src/lib.rs (same shape as the
// existing register_download_path; the runtime scope it extends is checked by
// the plugin's resolve_path as `fs_scope.scope.is_allowed(...)`).
const REGISTER_UPLOAD_PATH_CMD = 'register_upload_path';

// ENOENT from std::fs — the plugin formats io errors as
// "with error: <msg> (os error N)". os error 2 is the same value on Windows
// ("The system cannot find the file specified.") and Unix ("No such file or
// directory"). Matching on the numeric code keeps this cross-platform.
const NOT_FOUND_PATTERN = /os error 2/i;

// Minimal shapes of the plugin's serialized responses (camelCase via serde
// rename_all). Full FileInfo has many more fields — only what we consume.
interface DirEntryDto {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
}

interface StatInfoDto {
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
}

export interface DiskEntry {
  path: string;
  name: string;
  relativePath: string;
  isDirectory: boolean;
  size: number;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Prefix wraps the raw rejection so callers see WHERE it failed; the original
// detail stays in the message. (No `cause` option: tsconfig targets ES2020.)
function wrapError(prefix: string, err: unknown): Error {
  return new Error(`${prefix}: ${describeError(err)}`);
}

/**
 * Extend the fs plugin's runtime read scope so the given path (file or
 * directory tree) may be read from the webview. The webview must first have
 * the bare `fs:allow-read-file` / `fs:allow-read-dir` / `fs:allow-stat`
 * capabilities; this call is what authorizes the specific user-picked path.
 */
export async function registerUploadPath(path: string): Promise<void> {
  try {
    await invoke(REGISTER_UPLOAD_PATH_CMD, { path });
  } catch (err: unknown) {
    const wrapped = wrapError(`Failed to extend fs read scope for "${path}"`, err);
    captureError({ level: 'warn', source: 'diskFs', message: wrapped.message, kind: 'scope' });
    throw wrapped;
  }
}

/**
 * Stat a disk path. Returns null when the path does not exist (used by the
 * drop handler to tell files from folders); any other failure throws a
 * wrapped error.
 */
export async function statDiskPath(path: string): Promise<DiskEntry | null> {
  let info: StatInfoDto;
  try {
    info = await invoke<StatInfoDto>(FS_STAT_CMD, { path });
  } catch (err: unknown) {
    if (NOT_FOUND_PATTERN.test(describeError(err))) return null;
    const wrapped = wrapError(`Failed to stat "${path}"`, err);
    captureError({ level: 'warn', source: 'diskFs', message: wrapped.message, kind: 'stat' });
    throw wrapped;
  }
  const name = basename(path);
  return {
    path,
    name,
    relativePath: name,
    isDirectory: info.isDirectory,
    // Directories have no meaningful size; 0 keeps the DiskEntry contract.
    size: info.isDirectory ? 0 : info.size,
  };
}

/**
 * Read a file's bytes. The plugin returns a raw octet-stream response
 * (ArrayBuffer) on the fast IPC path and a JSON number[] on the fallback —
 * mirror the official guest-js readFile() normalization exactly.
 */
export async function readDiskFile(path: string): Promise<Uint8Array> {
  let payload: ArrayBuffer | number[];
  try {
    payload = await invoke<ArrayBuffer | number[]>(FS_READ_FILE_CMD, { path });
  } catch (err: unknown) {
    const wrapped = wrapError(`Failed to read file "${path}"`, err);
    captureError({ level: 'error', source: 'diskFs', message: wrapped.message, kind: 'read' });
    throw wrapped;
  }
  return payload instanceof ArrayBuffer ? new Uint8Array(payload) : Uint8Array.from(payload);
}

/**
 * Recursively walk a folder and return every entry (files AND subfolders)
 * under it, sorted deterministically by relativePath ('/' separators).
 * tauri-plugin-fs v2 read_dir has NO recursive option (verified in its
 * guest-js ReadDirOptions), so descent is done here, one read_dir per folder.
 * Throws a wrapped error when the root or any nested folder cannot be read.
 */
export async function walkDiskFolder(dirPath: string): Promise<DiskEntry[]> {
  const entries: DiskEntry[] = [];
  await walkDirRecursive(dirPath, dirPath, entries);
  // Plain code-unit comparison: stable across machines/locales (localeCompare
  // depends on the host locale, which would break snapshot expectations).
  entries.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
  return entries;
}

async function walkDirRecursive(dirPath: string, rootPath: string, out: DiskEntry[]): Promise<void> {
  let rawEntries: DirEntryDto[];
  try {
    rawEntries = await invoke<DirEntryDto[]>(FS_READ_DIR_CMD, { path: dirPath });
  } catch (err: unknown) {
    const wrapped = wrapError(`Failed to read directory "${dirPath}"`, err);
    captureError({ level: 'warn', source: 'diskFs', message: wrapped.message, kind: 'read-dir' });
    throw wrapped;
  }
  for (const entry of rawEntries) {
    const childPath = joinPath(dirPath, entry.name);
    out.push({
      path: childPath,
      name: entry.name,
      relativePath: toForwardSlashRelative(rootPath, childPath),
      isDirectory: entry.isDirectory,
      size: 0,
    });
    if (entry.isDirectory) {
      await walkDirRecursive(childPath, rootPath, out);
    }
  }
}

function joinPath(dirPath: string, name: string): string {
  return /[\\/]$/.test(dirPath) ? `${dirPath}${name}` : `${dirPath}\\${name}`;
}

// Strip the walked root and normalize separators: "C:\Music\sub\a.mp3" with
// root "C:\Music" becomes "sub/a.mp3" (no leading slash). Forward slashes
// are valid on Windows and keep relativePath portable to the Drive API.
function toForwardSlashRelative(rootPath: string, absolutePath: string): string {
  const rel = absolutePath.startsWith(rootPath) ? absolutePath.slice(rootPath.length) : absolutePath;
  return rel.replace(/^[\\/]+/, '').replace(/\\/g, '/');
}

// "C:\Music\a.mp3" -> "a.mp3"; "C:\Music\" -> "Music" (trailing sep stripped
// first so a root path yields its folder name, not "").
function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}
