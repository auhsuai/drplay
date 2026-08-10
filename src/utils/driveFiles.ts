import { getAudioFilesQuery } from "./audioQuery";
import { captureError } from "./errorLog";
import { driveFetch } from "./driveHttp";
import { DRIVE_MODULE, FOLDER_MIME } from "./driveTypes";
import type { DriveFileItem } from "./driveTypes";

// "Recently Added to Drive" fetches a single page of the newest files. 100 is
// the largest page size Drive returns per request; it must exceed every
// responsive grid count (2/4/5) so the grid can always tell "list is full →
// more files may exist" apart from "list really is that short".
const RECENTLY_ADDED_PAGE_SIZE = 100;

// Drive Files API base URL — every request in this module targets it.
const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";

// Headers shared by every Drive request in this module. GET/DELETE calls only
// need the bearer token; JSON-body calls add the JSON content type. Exported
// because the fetchWithAuth-based hooks build the same header inline; reusing
// this helper keeps the "Bearer <token>" format in one place.
export function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function authJsonHeaders(token: string): Record<string, string> {
  return { ...authHeaders(token), "Content-Type": "application/json" };
}

// Shared guard for the simple `Failed to <action> (status)` throw pattern.
// NOT used where a non-ok response has its own handling (null returns,
// captureError + detail parsing in moveFile, quota, etc.).
function assertDriveOk(response: Response, action: string): void {
  if (!response.ok) {
    throw new Error(`Failed to ${action} (${String(response.status)})`);
  }
}

// Drive API JSON responses are untyped at the wire level — narrow a parsed
// body's `parents` field to a string[]. Anything malformed → [] (same runtime
// fallback as the previous any-typed reads).
function parseParentsList(data: unknown): string[] {
  if (typeof data !== "object" || data === null) return [];
  const parents = (data as { parents?: unknown }).parents;
  if (!Array.isArray(parents)) return [];
  return parents.filter((p): p is string => typeof p === "string");
}

// Same narrowing for `files` — Drive list responses may be absent/malformed.
export function parseFilesList(data: unknown): DriveFileItem[] {
  if (typeof data !== "object" || data === null) return [];
  const files = (data as { files?: unknown }).files;
  return Array.isArray(files) ? (files as DriveFileItem[]) : [];
}

function parseName(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const name = (data as { name?: unknown }).name;
  return typeof name === "string" ? name : null;
}

// Never logs the raw body — only a string message field, if it is one.
function getErrorMessage(errData: unknown): string | null {
  if (typeof errData !== "object" || errData === null) return null;
  const message = (errData as { error?: { message?: unknown } }).error?.message;
  return typeof message === "string" ? message : null;
}

// signal?: AbortSignal wires a caller cancel (uploadManager batch controller)
// into the request; driveFetch already turns a caller abort into an immediate
// non-retried rejection. Optional: callers like useDriveExplorer omit it.
/**
 * Create a folder on Drive. Shared by the explorer's "new folder" flow and
 * the upload manager's folder batches (which pass a cancel signal so an
 * aborted upload cannot leave half-created folders behind).
 * @param token Drive access token.
 * @param name Display name of the new folder.
 * @param parentId Drive id of the parent folder.
 * @param signal Optional cancel — driveFetch turns the abort into an
 * immediate non-retried rejection.
 * @returns The created folder's Drive metadata (id is the meaningful field).
 */
export async function createFolder(
  token: string,
  name: string,
  parentId: string,
  signal?: AbortSignal,
): Promise<DriveFileItem> {
  const metadata = {
    name: name,
    mimeType: FOLDER_MIME,
    parents: [parentId],
  };

  const response = await driveFetch(DRIVE_FILES_URL, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify(metadata),
    ...(signal ? { signal } : {}),
  });

  assertDriveOk(response, "create folder");
  const data: unknown = await response.json();
  return data as DriveFileItem;
}

/**
 * Move a file/folder to the Drive trash (soft delete) and tag it with
 * `deletedByDrPlay` so a later restore knows it was DrPlay-deleted. Permanent
 * deletion is never used from the UI — trash keeps accidental deletes
 * recoverable.
 * @param token Drive access token.
 * @param fileId The id to trash.
 * @returns The trashed file's Drive metadata.
 */
export async function deleteFile(
  token: string,
  fileId: string,
): Promise<DriveFileItem> {
  // Move to trash instead of permanent delete for safety
  const metadata = {
    trashed: true,
    appProperties: {
      deletedByDrPlay: "true",
    },
  };

  const response = await driveFetch(`${DRIVE_FILES_URL}/${fileId}`, {
    method: "PATCH",
    headers: authJsonHeaders(token),
    body: JSON.stringify(metadata),
  });

  assertDriveOk(response, "delete file");
  const data: unknown = await response.json();
  return data as DriveFileItem;
}

/**
 * Move a file/folder to another parent. First reads the item's real parent
 * list so it is removed from ALL of them (Drive allows multiple parents), and
 * short-circuits with { success: true } when the target is already a parent
 * (avoids a 400 from the add+remove combo). Non-ok responses log a sanitized
 * status/detail (never the raw body — it can embed file ids) and throw.
 * @param token Drive access token.
 * @param fileId The id to move.
 * @param currentParentId The parent DrPlay currently shows it under.
 * @param newParentId The destination folder id.
 * @returns The moved file's metadata, or { success: true } on the
 * already-in-target no-op path.
 */
export async function moveFile(
  token: string,
  fileId: string,
  currentParentId: string,
  newParentId: string,
): Promise<DriveFileItem | { success: boolean }> {
  // First, get the actual parents of the file to ensure we remove it from all of them
  const getResponse = await driveFetch(
    `${DRIVE_FILES_URL}/${fileId}?fields=parents`,
    {
      headers: authHeaders(token),
    },
  );

  let removeParents = currentParentId;
  if (getResponse.ok) {
    const data: unknown = await getResponse.json();
    const parents = parseParentsList(data);
    if (parents.length > 0) {
      removeParents = parents.join(",");

      // If the file is already in the new parent, do nothing to prevent 400 error
      if (parents.includes(newParentId)) {
        return { success: true };
      }
    }
  }

  const response = await driveFetch(
    `${DRIVE_FILES_URL}/${fileId}?addParents=${newParentId}&removeParents=${removeParents}`,
    {
      method: "PATCH",
      headers: authJsonHeaders(token),
      body: JSON.stringify({}),
    },
  );

  if (!response.ok) {
    const errData: unknown = await response.json().catch(() => null);
    // Do NOT log the raw error body (errData) — it can contain file ids / user
    // data. Log only the public status and a sanitized message (never the object).
    const detail = getErrorMessage(errData);
    await captureError({
      level: "error",
      source: DRIVE_MODULE,
      message: `move-file-failed (status=${String(response.status)}): ${detail ?? "no detail"}`,
    });
    throw new Error(`Failed to move file (${String(response.status)})`);
  }
  const data: unknown = await response.json();
  return data as DriveFileItem;
}

/**
 * Untrash a file DrPlay previously deleted (clears the `deletedByDrPlay`
 * app-property marker too, so the item returns to a clean state).
 * @param token Drive access token.
 * @param fileId The id to restore.
 * @returns The restored file's Drive metadata.
 */
export async function restoreFile(
  token: string,
  fileId: string,
): Promise<DriveFileItem> {
  const metadata = {
    trashed: false,
    appProperties: {
      deletedByDrPlay: null,
    },
  };

  const response = await driveFetch(`${DRIVE_FILES_URL}/${fileId}`, {
    method: "PATCH",
    headers: authJsonHeaders(token),
    body: JSON.stringify(metadata),
  });

  assertDriveOk(response, "restore file");
  const data: unknown = await response.json();
  return data as DriveFileItem;
}

/**
 * Hard-delete a file. Deliberately NOT exposed through the normal UI (the app
 * trash-soft-deletes via deleteFile); kept for the few flows that genuinely
 * need the item gone (e.g. emptying trash).
 * @param token Drive access token.
 * @param fileId The id to delete permanently.
 * @returns true once Drive confirms the deletion; throws otherwise.
 */
export async function permanentlyDeleteFile(
  token: string,
  fileId: string,
): Promise<boolean> {
  const response = await driveFetch(`${DRIVE_FILES_URL}/${fileId}`, {
    method: "DELETE",
    headers: authHeaders(token),
  });

  assertDriveOk(response, "permanently delete file");
  return true;
}

/**
 * One page of the newest audio files in the user's whole Drive (sorted by
 * createdTime desc) for the "Recently Added" section. Page size is fixed at
 * 100 — larger than every grid count so the UI can tell "full list" from
 * "list really is that short".
 * @param token Drive access token.
 * @returns The newest audio files (empty array on malformed payloads).
 */
export async function getRecentlyAddedAudioFiles(
  token: string,
): Promise<DriveFileItem[]> {
  const q = getAudioFilesQuery();
  const url = `${DRIVE_FILES_URL}?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,size,modifiedTime)&orderBy=createdTime desc&pageSize=${String(RECENTLY_ADDED_PAGE_SIZE)}`;

  const response = await driveFetch(url, {
    headers: authHeaders(token),
  });

  assertDriveOk(response, "fetch recently added audio files");

  const data: unknown = await response.json();
  return parseFilesList(data);
}

/**
 * Return the parent ids of a file/folder. Returns null when the Drive request
 * fails (or the file has no parents) so callers can fall back to root.
 * @param token Drive access token.
 * @param fileId The id to look up.
 * @param signal Optional cancel signal.
 * @returns The parent id list, or null on failure/no parents.
 */
export async function getFileParents(
  token: string,
  fileId: string,
  signal?: AbortSignal,
): Promise<string[] | null> {
  const url = `${DRIVE_FILES_URL}/${fileId}?fields=parents`;
  const response = await driveFetch(url, {
    headers: authHeaders(token),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    return null;
  }
  const data: unknown = await response.json();
  return parseParentsList(data);
}

/**
 * Fetch a file/folder's display name. Returns null on failure (callers show
 * a fallback label instead of crashing).
 * @param token Drive access token.
 * @param fileId The id to look up.
 * @param signal Optional cancel signal.
 * @returns The display name, or null on failure.
 */
export async function getFileName(
  token: string,
  fileId: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const url = `${DRIVE_FILES_URL}/${fileId}?fields=name`;
  const response = await driveFetch(url, {
    headers: authHeaders(token),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    return null;
  }
  const data: unknown = await response.json();
  return parseName(data);
}
