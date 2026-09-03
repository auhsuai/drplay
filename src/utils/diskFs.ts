import { invoke } from "@tauri-apps/api/core";
import { captureError } from "./errorLog";
import { basename } from "./pathUtils";

// tauri-plugin-fs v2 command names, verified against the plugins-workspace v2
// guest-js (raw.githubusercontent.com/tauri-apps/plugins-workspace/v2/plugins/fs/guest-js/index.ts,
// fetched 2026-08-02). The repo does NOT use @tauri-apps/plugin-fs npm
// bindings — it invokes the plugin commands directly (same pattern as
// useMenuDownload.ts:121).
const FS_READ_DIR_CMD = "plugin:fs|read_dir";
const FS_STAT_CMD = "plugin:fs|stat";
// Streaming read commands (guest-js FileHandle pattern): open returns a
// resource id (rid) that sequential read() calls consume, and close releases.
const FS_OPEN_CMD = "plugin:fs|open";
const FS_READ_CMD = "plugin:fs|read";
// tauri-plugin-fs v2 has NO `plugin:fs|close` command (verified in
// tauri-plugin-fs 2.5.1 lib.rs invoke_handler: only create/open/read/seek/
// fstat/... are registered). File handles are core Resources: the official
// guest-js `FileHandle.close()` falls back to core Resource.close(), which
// invokes `plugin:resources|close` (core.js:272). That core command is
// enabled by default (`core:resources` allow-close in tauri build.rs
// core:default), so no capability change is required.
const FS_CLOSE_CMD = "plugin:resources|close";

// Default streaming read granularity. The Drive resumable protocol requires
// upload chunks to be multiples of 256 KiB (except the final chunk), and 8 MiB
// satisfies that — the uploader reads chunks of exactly this size.
export const DEFAULT_READ_CHUNK_SIZE = 8 * 1024 * 1024;

// plugin:fs|read appends the number of bytes actually read (nread) as 8
// big-endian bytes at the END of the payload (guest-js FileHandle.read
// convention, verified in plugins-workspace v2 guest-js source).
const NREAD_BYTES = 8;

// Custom Rust command registered in src-tauri/src/lib.rs (same shape as the
// existing register_download_path; the runtime scope it extends is checked by
// the plugin's resolve_path as `fs_scope.scope.is_allowed(...)`).
const REGISTER_UPLOAD_PATH_CMD = "register_upload_path";

// ENOENT from std::fs — the plugin formats io errors as
// "with error: <msg> (os error N)". os error 2 is the same value on Windows
// ("The system cannot find the file specified.") and Unix ("No such file or
// directory"). Matching the parenthesized Display form (NOT a bare "os error
// 2" substring, which would also match 20/21/24/267 and swallow real
// failures as not-found) keeps this cross-platform.
const NOT_FOUND_PATTERN = /\(os error 2\)/;

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
    const wrapped = wrapError(
      `Failed to extend fs read scope for "${path}"`,
      err,
    );
    await captureError({
      level: "warn",
      source: "diskFs",
      message: wrapped.message,
      kind: "scope",
    });
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
    await captureError({
      level: "warn",
      source: "diskFs",
      message: wrapped.message,
      kind: "stat",
    });
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
 * A sequential read handle over a disk file. Each read() returns at most
 * `chunkSize` bytes and null at end of file; close() releases the underlying
 * resource. Memory stays bounded at chunkSize no matter how large the file is
 * (unlike a whole-file read, which would materialize the file in the JS heap).
 */
export interface DiskReadStream {
  read(): Promise<Uint8Array | null>; // null = end of file
  close(): Promise<void>;
}

// Parse the plugin's big-endian 8-byte nread trailer (same algorithm as
// guest-js fromBytes).
function fromBigEndian(bytes: Uint8Array): number {
  let x = 0;
  for (let i = 0; i < bytes.length; i++) {
    x *= 0x100;
    x += bytes[i] ?? 0;
  }
  return x;
}

export async function openDiskReadStream(
  path: string,
  chunkSize: number = DEFAULT_READ_CHUNK_SIZE,
): Promise<DiskReadStream> {
  let rid: number;
  try {
    rid = await invoke<number>(FS_OPEN_CMD, { path, options: { read: true } });
  } catch (err: unknown) {
    const wrapped = wrapError(`Failed to open file "${path}"`, err);
    await captureError({
      level: "warn",
      source: "diskFs",
      message: wrapped.message,
      kind: "stream-open",
    });
    throw wrapped;
  }

  async function read(): Promise<Uint8Array | null> {
    let payload: ArrayBuffer | number[];
    try {
      payload = await invoke<ArrayBuffer | number[]>(FS_READ_CMD, {
        rid,
        len: chunkSize,
      });
    } catch (err: unknown) {
      const wrapped = wrapError(`Failed to read file "${path}"`, err);
      await captureError({
        level: "warn",
        source: "diskFs",
        message: wrapped.message,
        kind: "stream-read",
      });
      throw wrapped;
    }
    const arr =
      payload instanceof ArrayBuffer
        ? new Uint8Array(payload)
        : Uint8Array.from(payload);
    // The plugin guarantees ≥8 elements; anything shorter is a protocol
    // violation and would misparse nread into silently wrong chunk data.
    if (arr.byteLength < NREAD_BYTES) {
      const wrapped = new Error(
        `Failed to read file "${path}": malformed stream response`,
      );
      await captureError({
        level: "warn",
        source: "diskFs",
        message: wrapped.message,
        kind: "stream-read",
      });
      throw wrapped;
    }
    const nread = fromBigEndian(arr.slice(arr.byteLength - NREAD_BYTES));
    if (nread === 0) return null; // end of file
    return arr.slice(0, arr.byteLength - NREAD_BYTES);
  }

  // Close errors are logged, not thrown: close runs from a caller finally and
  // must never mask the primary outcome (upload result or an earlier error).
  async function close(): Promise<void> {
    try {
      await invoke(FS_CLOSE_CMD, { rid });
    } catch (err: unknown) {
      const wrapped = wrapError(`Failed to close file "${path}"`, err);
      await captureError({
        level: "warn",
        source: "diskFs",
        message: wrapped.message,
        kind: "stream-close",
      });
    }
  }

  return { read, close };
}

/**
 * Recursively walk a folder and return every entry (files AND subfolders)
 * under it, sorted deterministically by relativePath ('/' separators).
 * tauri-plugin-fs v2 read_dir has NO recursive option (verified in its
 * guest-js ReadDirOptions), so descent is done here, one read_dir per folder.
 * Throws a wrapped error when the root or any nested folder cannot be read.
 * A caller-supplied AbortSignal (user cancel) aborts the walk between IPC
 * calls with an AbortError — the batch caller normalizes it to its own
 * 'aborted' error kind.
 */
export async function walkDiskFolder(
  dirPath: string,
  signal?: AbortSignal,
): Promise<DiskEntry[]> {
  // Fail fast on an already-aborted walk: a cancel must never descend into IPC.
  throwIfWalkAborted(signal);
  const entries: DiskEntry[] = [];
  await walkDirRecursive(dirPath, dirPath, entries, signal);
  // Plain code-unit comparison: stable across machines/locales (localeCompare
  // depends on the host locale, which would break snapshot expectations).
  entries.sort((a, b) =>
    a.relativePath < b.relativePath
      ? -1
      : a.relativePath > b.relativePath
        ? 1
        : 0,
  );
  return entries;
}

// MDN AbortSignal guidance ("Implementing an abortable API"): a Promise-based
// API that takes a signal rejects with the abort reason instead of completing
// (developer.mozilla.org/en-US/docs/Web/API/AbortSignal, fetched 2026-08-02).
// A cancel is deliberately NOT wrapped in wrapError/captureError: it is not a
// disk failure, and logging the walk path would leak it into the error log.
function throwIfWalkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
}

async function walkDirRecursive(
  dirPath: string,
  rootPath: string,
  out: DiskEntry[],
  signal?: AbortSignal,
): Promise<void> {
  // Fail before every read_dir IPC so an abort never schedules new work.
  throwIfWalkAborted(signal);
  let rawEntries: DirEntryDto[];
  try {
    rawEntries = await invoke<DirEntryDto[]>(FS_READ_DIR_CMD, {
      path: dirPath,
    });
  } catch (err: unknown) {
    const wrapped = wrapError(`Failed to read directory "${dirPath}"`, err);
    await captureError({
      level: "warn",
      source: "diskFs",
      message: wrapped.message,
      kind: "read-dir",
    });
    throw wrapped;
  }
  for (const entry of rawEntries) {
    // An abort that landed while read_dir was pending stops mid-iteration.
    throwIfWalkAborted(signal);
    // A symlinked directory (Windows junction, mklink /D) must NOT be
    // descended: the plugin reports both isDirectory and isSymlink for it
    // (read_dir uses std entry.file_type(), which does not follow the link),
    // and following one hangs the walk forever on a junction cycle and kills
    // the whole batch on ACL-protected system junctions ("Application Data").
    // The entry is skipped entirely — a reparse point is not the user's own
    // music content. Symlinked FILES are kept: open() reads through the link.
    if (entry.isDirectory && entry.isSymlink) continue;
    const childPath = joinPath(dirPath, entry.name);
    out.push({
      path: childPath,
      name: entry.name,
      relativePath: toForwardSlashRelative(rootPath, childPath),
      isDirectory: entry.isDirectory,
      size: 0,
    });
    if (entry.isDirectory) {
      await walkDirRecursive(childPath, rootPath, out, signal);
    }
  }
}

function joinPath(dirPath: string, name: string): string {
  return /[\\/]$/.test(dirPath) ? `${dirPath}${name}` : `${dirPath}\\${name}`;
}

// Strip the walked root and normalize separators: "C:\Music\sub\a.mp3" with
// root "C:\Music" becomes "sub/a.mp3" (no leading slash). Forward slashes
// are valid on Windows and keep relativePath portable to the Drive API.
// Exported for unit testing only; internal callers unchanged.
export function toForwardSlashRelative(
  rootPath: string,
  absolutePath: string,
): string {
  // Only strip when absolutePath is genuinely UNDER rootPath: the remainder
  // must be empty, start with a separator, or the root itself must end with
  // one. A bare startsWith() would let a sibling sharing a string prefix
  // ("C:\MusicExtra") match root "C:\Music" and corrupt its relativePath.
  const rest = absolutePath.slice(rootPath.length);
  const underRoot =
    rest === "" || /^[\\/]/.test(rest) || /[\\/]$/.test(rootPath);
  const rel = underRoot ? rest : absolutePath;
  return rel.replace(/^[\\/]+/, "").replace(/\\/g, "/");
}
