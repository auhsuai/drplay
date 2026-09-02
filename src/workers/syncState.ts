// Shared sync-pass state for the proSync worker (refactor: extracted from
// syncRunner.ts — the Drive endpoint constants, the wire-frame token holder,
// and the 401 retry budget). The token is read at fetch time — a mid-run
// rotation replaces it before the retry refetches, so every fetch always
// sends the freshest token (same semantics as the pre-split module variable).
import { refreshTokenAndRetry, syncRetryDeps } from "./tokenRefresh";

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

export { refreshTokenAndRetry, syncRetryDeps };
