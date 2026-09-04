// Shared sync-pass state for the proSync worker (refactor: extracted from
// syncRunner.ts — the Drive endpoint constants, the wire-frame token holder,
// and the 401 retry budget). The token is read at fetch time — a mid-run
// rotation replaces it before the retry refetches, so every fetch always
// sends the freshest token (same semantics as the pre-split module variable).
import { fetchDrive } from "./driveFetch";
import { refreshTokenAndRetry, syncRetryDeps } from "./tokenRefresh";
import type { DriveFile as DriveFileItem } from "./driveMapping";
import { toUpsertableFileRow } from "./driveMapping";

// Dexie syncState key holding the Drive changes start-page token.
export const START_PAGE_TOKEN_KEY = "startPageToken";

// Drive API v3 endpoints — base + derived names (values byte-identical to the
// historical literals; DRIVE_FILES_URL mirrors src/utils/driveFiles.ts).
export const DRIVE_SYNC_URL = "https://www.googleapis.com/drive/v3";
export const DRIVE_FILES_URL = `${DRIVE_SYNC_URL}/files`;
export const DRIVE_CHANGES_URL = `${DRIVE_SYNC_URL}/changes`;
export const DRIVE_START_PAGE_TOKEN_URL = `${DRIVE_CHANGES_URL}/startPageToken`;

// File projection shared by the files-list and changes fields parameters.
export const FILES_FIELDS = "id,name,mimeType,parents,size,modifiedTime";

// Bearer token recorded per wire frame ("sync"/"token" messages). Read at
// fetch time via getCurrentToken so a mid-run rotation (pushToken) is picked
// up by every retry refetch — identical to the pre-split module variable.
let currentToken: string | null = null;

export function setCurrentToken(token: string): void {
  currentToken = token;
}

export function hasCurrentToken(): boolean {
  return currentToken !== null;
}

export function getCurrentToken(): string | null {
  return currentToken;
}

// Retry budget shared by all 401 paths of one sync pass; reset on successful
// refresh (inside refreshTokenAndRetry) and on a 410 delta reset.
const MAX_SYNC_RETRIES = 3;
export const syncRetry = { count: 0, max: MAX_SYNC_RETRIES };

// One Drive fetch with the shared 401 → TOKEN_EXPIRED → same-URL retry loop.
// Used by all three fetch sites (full-sync startPageToken, full-sync files,
// delta-sync changes). The retry re-issues the IDENTICAL URL: Drive rejects
// the 401 request without advancing its page cursor, so the same pageToken is
// correct, and each refetch reads the current token — a mid-run rotation
// therefore retries with the fresh token. Resolves with the last response:
// when the refresh budget is exhausted the response is still 401 and the
// caller's normal non-ok handling reports the failure exactly once.
export async function fetchDriveWithAuthRetry(
  fetchCtx: string,
  retryCtx: string,
  url: URL,
): Promise<Response> {
  let res = await fetchDrive(fetchCtx, currentToken as string, url);
  while (!res.ok && res.status === 401) {
    if (!(await refreshTokenAndRetry(syncRetry, syncRetryDeps, retryCtx))) {
      break;
    }
    res = await fetchDrive(fetchCtx, currentToken as string, url);
  }
  return res;
}

// Canonical-parent rule: parentId is derived INSIDE upsertFileRows from
// parents[0] of the very response the row came from; the helper stamps
// ownerEmail authoritatively (the composed userEmail below is the
// type-required provisional value upsertFileRows overwrites).
// `file` must be the post-guard shape (id guaranteed by isValidDriveFile or
// partitionValidFiles) — the same narrowing the original syncRunner applied
// before calling toUpsertableFileRow.
export function buildOwnerRow(
  file: DriveFileItem & { id: string },
  isFolder: boolean,
  ownerEmail: string,
) {
  return {
    ...toUpsertableFileRow(file, isFolder),
    userEmail: ownerEmail,
  };
}

export { refreshTokenAndRetry, syncRetryDeps };
