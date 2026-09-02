import { getAudioFilesQuery } from "./audioQuery";
import { authHeaders, authJsonHeaders } from "./authHeaders";
import { captureError } from "./errorLog";
import { driveFetch } from "./driveHttp";
import { DRIVE_MODULE, FOLDER_MIME } from "./driveTypes";
import type { DriveFileItem, DriveFilesListResponse } from "./driveTypes";
import { IS_MOBILE } from "./platform";
import { MAX_PAGINATION_PAGES, PAGINATION_PAGE_SIZE } from "./driveConstants";

// Re-exported so the ~15 main-thread callers importing authHeaders from
// driveFiles keep working; the implementation now lives in the
// dependency-free authHeaders module shared with the proSync worker.
export { authHeaders };

// "Recently Added to Drive" fetches a single page of the newest files. 100
// bounds the response (Drive's default page size for shared drives; the max
// is 1000) and must exceed every responsive grid count (2/4/5) so the grid
// can always tell "list is full → more files may exist" apart from "list
// really is that short".
const RECENTLY_ADDED_PAGE_SIZE = 100;

// Drive Files API base URL — every request in this module targets it.
export const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";

// Shared guard for the simple `Failed to <action> (status)` throw pattern.
// NOT used where a non-ok response has its own handling (null returns,
// captureError + detail parsing in moveFile, quota, etc.).
function assertDriveOk(response: Response, action: string): void {
  if (!response.ok) {
    throw new Error(`Failed to ${action} (${String(response.status)})`);
  }
}

// A 200 body that is not JSON (proxy truncation, wrong Content-Type, server
// bug) would otherwise surface as a raw SyntaxError from json(); classify it
// so callers can show a meaningful message (same pattern as fetchAllPages in
// drivePagination.ts). Never logs the raw body (may be huge/opaque).
async function readJsonOrInvalidResponse(
  response: Response,
  action: string,
): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(`Failed to ${action} (invalid response)`);
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

// Narrow a single-item response (create/delete/move/restore). Required fields
// on DriveFileItem are id/name/mimeType — anything less is not an item, so the
// callers fail in a controlled way instead of leaking an object missing
// required fields into the app.
function parseDriveFileItem(data: unknown): DriveFileItem | null {
  if (typeof data !== "object" || data === null) return null;
  const item = data as Partial<DriveFileItem>;
  if (typeof item.id !== "string") return null;
  if (typeof item.name !== "string") return null;
  if (typeof item.mimeType !== "string") return null;
  return item as DriveFileItem;
}

function parseName(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const name = (data as { name?: unknown }).name;
  return typeof name === "string" ? name : null;
}

// Shared tail for the simple write endpoints: assert ok, parse the JSON body
// into a DriveFileItem, and throw the canonical invalid-response error
// otherwise. moveFile does NOT use this (its non-ok path has its own
// captureError + detail handling).
async function readItemOrThrow(
  response: Response,
  action: string,
): Promise<DriveFileItem> {
  assertDriveOk(response, action);
  const data: unknown = await readJsonOrInvalidResponse(response, action);
  const item = parseDriveFileItem(data);
  if (item === null) throw new Error(`Failed to ${action} (invalid response)`);
  return item;
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

  return readItemOrThrow(response, "create folder");
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

  const response = await driveFetch(
    `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}`,
    {
      method: "PATCH",
      headers: authJsonHeaders(token),
      body: JSON.stringify(metadata),
    },
  );

  return readItemOrThrow(response, "delete file");
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
    `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?fields=parents`,
    {
      headers: authHeaders(token),
    },
  );

  let removeParents = currentParentId;
  if (getResponse.ok) {
    const data: unknown = await readJsonOrInvalidResponse(
      getResponse,
      "move file",
    );
    const parents = parseParentsList(data);
    if (parents.length > 0) {
      removeParents = parents.join(",");

      // If the file is already in the new parent, do nothing to prevent 400 error
      if (parents.includes(newParentId)) {
        return { success: true };
      }
    }
  }

  const moveParams = new URLSearchParams({
    addParents: newParentId,
    removeParents,
  });
  const response = await driveFetch(
    `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?${moveParams.toString()}`,
    {
      method: "PATCH",
      headers: authHeaders(token),
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
  const data: unknown = await readJsonOrInvalidResponse(response, "move file");
  const item = parseDriveFileItem(data);
  if (item === null) throw new Error("Failed to move file (invalid response)");
  return item;
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

  const response = await driveFetch(
    `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}`,
    {
      method: "PATCH",
      headers: authJsonHeaders(token),
      body: JSON.stringify(metadata),
    },
  );

  return readItemOrThrow(response, "restore file");
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
  const response = await driveFetch(
    `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}`,
    {
      method: "DELETE",
      headers: authHeaders(token),
    },
  );

  assertDriveOk(response, "permanently delete file");
  return true;
}

/**
 * The newest audio files in the user's whole Drive (sorted by createdTime
 * desc) for the "Recently Added" section.
 * Desktop: exactly one page of 100 — larger than every responsive grid count
 * (2/4/5) so the UI can tell "full list" from "list really is that short"
 * (historical contract, unchanged).
 * Mobile (Task 14): no load-more/pagination UX exists, so the pageToken loop
 * runs automatically to the MAX_PAGINATION_PAGES safety cap (10 x 1000).
 * @param token Drive access token.
 * @returns The newest audio files (empty array on malformed payloads).
 */
export async function getRecentlyAddedAudioFiles(
  token: string,
): Promise<DriveFileItem[]> {
  const q = getAudioFilesQuery();
  // Desktop keeps the historical single-page fetch byte-for-byte.
  if (!IS_MOBILE) {
    const url = `${DRIVE_FILES_URL}?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,size,modifiedTime)&orderBy=createdTime desc&pageSize=${String(RECENTLY_ADDED_PAGE_SIZE)}`;

    const response = await driveFetch(url, {
      headers: authHeaders(token),
    });

    assertDriveOk(response, "fetch recently added audio files");

    const data: unknown = await readJsonOrInvalidResponse(
      response,
      "fetch recently added audio files",
    );
    return parseFilesList(data);
  }

  // Mobile: aggregate every page up to the cap, writing nothing in between
  // (this call returns the full list to HomeTab in one shot).
  const all: DriveFileItem[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGINATION_PAGES; page++) {
    const url = new URL(DRIVE_FILES_URL);
    url.searchParams.set("q", q);
    // nextPageToken MUST stay in the fields mask — Drive's partial response
    // silently drops it otherwise (same warning as drivePagination.ts).
    url.searchParams.set(
      "fields",
      "nextPageToken,files(id,name,mimeType,size,modifiedTime)",
    );
    url.searchParams.set("orderBy", "createdTime desc");
    url.searchParams.set("pageSize", String(PAGINATION_PAGE_SIZE));
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const response = await driveFetch(url.toString(), {
      headers: authHeaders(token),
    });

    assertDriveOk(response, "fetch recently added audio files");

    const data = (await readJsonOrInvalidResponse(
      response,
      "fetch recently added audio files",
    )) as DriveFilesListResponse | null;
    if (data && Array.isArray(data.files)) all.push(...data.files);
    pageToken = data?.nextPageToken;
    if (!pageToken) break;
  }
  // Loop ended with a token in hand → the cap was hit. Log (no user-facing
  // toast here: a background list topping 10k newest files is a hard edge).
  if (pageToken) {
    void captureError({
      level: "warn",
      source: DRIVE_MODULE,
      message: "recently-added-truncated-at-cap",
    });
  }
  return all;
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
  const url = `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?fields=parents`;
  const response = await driveFetch(url, {
    headers: authHeaders(token),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    return null;
  }
  const data: unknown = await readJsonOrInvalidResponse(
    response,
    "get file parents",
  );
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
  const url = `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?fields=name`;
  const response = await driveFetch(url, {
    headers: authHeaders(token),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    return null;
  }
  const data: unknown = await readJsonOrInvalidResponse(
    response,
    "get file name",
  );
  return parseName(data);
}
