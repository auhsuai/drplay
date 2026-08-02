import { db } from '../db/db';
import type { DriveFile as DriveFileRow } from '../db/db';
import { getAudioQuery, isAudioFile } from '../utils/audioQuery';
import { FOLDER_MIME } from '../utils/driveApi';
import { classifyWorkerError, logWorkerError, WorkerAbortError } from './workerError';

interface DriveFile {
  id?: string; name?: string; mimeType?: string; size?: string;
  parents?: string[]; trashed?: boolean; createdTime?: string;
  modifiedTime?: string; md5Checksum?: string;
}
interface DriveChangesList { changes?: DriveChange[]; nextPageToken?: string; newStartPageToken?: string; }
interface DriveChange { file?: DriveFile; fileId?: string; removed?: boolean; changeType?: string; }

let isBusy = false;
let currentToken: string | null = null;
let tokenRefreshResolver: ((value: boolean) => void) | null = null;
const MAX_SYNC_RETRIES = 3;
const syncRetry = { count: 0, max: MAX_SYNC_RETRIES };
const SYNC_FETCH_TIMEOUT_MS = 30000;
const TOKEN_REFRESH_TIMEOUT_MS = 15000;
// Transient HTTP errors (429 rate-limit, 5xx server errors, and 403 whose
// JSON error body reports a Drive rate-limit reason) are retried with bounded
// exponential backoff (base * 2^attempt + jitter), honoring the Retry-After
// header (capped at MAX_RETRY_DELAY_MS) — max 3 attempts, never retried
// forever (AGENTS.md Luật 4).
const MAX_TRANSIENT_RETRIES = 2;
const TRANSIENT_RETRY_BASE_DELAY_MS = 1000;
// Upper bound for a Retry-After-derived delay so a misbehaving server cannot
// stall a sync indefinitely.
const MAX_RETRY_DELAY_MS = 8000;
// Random extra delay (0..500ms) added to every retry so concurrent syncs do
// not retry in lockstep (thundering herd).
const RETRY_JITTER_MAX_MS = 500;
// Google Drive reports rate limiting as 403 with these `error.errors[].reason`
// values (usage limits): https://developers.google.com/drive/api/guides/handle-errors
const DRIVE_RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);

function toSize(raw: string | undefined | null): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

// Shared mapping of a Google Drive file resource to the DB row shape used by
// both full-sync and delta-sync. isFolder is a parameter so callers that
// already computed it (delta-sync) don't recompute it.
export function toDriveFileRow(f: DriveFile, isFolder: boolean): DriveFileRow {
  return {
    id: f.id!,
    name: f.name!,
    mimeType: f.mimeType!,
    parentId: f.parents && f.parents.length > 0 ? f.parents[0] : 'root',
    size: toSize(f.size),
    modifiedTime: f.modifiedTime,
    trashed: false,
    isFolder,
  };
}

// Guard for files missing a usable `id`. Drive can theoretically omit `id`
// on a file resource; filtering before map/bulkPut keeps one malformed file
// from failing an entire full-sync page, since Dexie bulkPut aborts its
// whole transaction on an invalid primary key.
export function isValidDriveFile(f: DriveFile): boolean {
  return typeof f.id === 'string' && f.id.length > 0;
}

// Partitions a page of Drive files into the subset that can be persisted
// (has a usable id) and a count of silently-unpersistable ones. Callers log a
// single summary line when skippedCount > 0 so missing-id files are never
// dropped without a trace (AGENTS.md Luật 4 — no silent error swallowing).
export function partitionValidFiles(files: DriveFile[]): { valid: DriveFile[]; skippedCount: number } {
  let skippedCount = 0;
  const valid: DriveFile[] = [];
  for (const f of files) {
    if (isValidDriveFile(f)) valid.push(f);
    else skippedCount += 1;
  }
  return { valid, skippedCount };
}

async function waitForTokenRefresh(timeoutMs = TOKEN_REFRESH_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      tokenRefreshResolver = null;
      resolve(false);
    }, timeoutMs);
    tokenRefreshResolver = (ok: boolean) => {
      clearTimeout(timer);
      tokenRefreshResolver = null;
      resolve(ok);
    };
  });
}

export interface SyncRetryState {
  count: number;
  max: number;
}

// Injected deps so unit tests can stub postMessage / waitForTokenRefresh
// without a real worker scope or network.
export interface RefreshTokenRetryDeps {
  postMessage: (msg: { type: string }) => void;
  waitForTokenRefresh: () => Promise<boolean>;
}

// Shared 401 handler used by all three Drive fetch loops (full-sync
// startPageToken, full-sync files, delta-sync changes). Returns true when the
// caller should retry the request after a successful token refresh; returns
// false when it must give up (retries exhausted) or the refresh failed, and
// the caller decides whether to return/break. Extracted so the retry-count
// logic lives in one place instead of being copy-pasted three times.
export async function refreshTokenAndRetry(
  state: SyncRetryState,
  deps: RefreshTokenRetryDeps,
  ctx: string,
): Promise<boolean> {
  if (state.count >= state.max) {
    logWorkerError(
      'proSync/' + ctx,
      { kind: 'auth', status: 401, reason: 'max-retries' },
      new Error('token refresh retries exhausted'),
      'error'
    );
    deps.postMessage({ type: 'SYNC_ERROR' });
    return false;
  }
  state.count += 1;
  deps.postMessage({ type: 'TOKEN_EXPIRED' });
  const refreshed = await deps.waitForTokenRefresh();
  if (refreshed) {
    state.count = 0;
    return true;
  }
  return false;
}

// Production bindings: post to the worker's parent scope and wait on the
// module-level refresh resolver. Tests inject their own deps instead.
const syncRetryDeps: RefreshTokenRetryDeps = {
  postMessage: (msg) => self.postMessage(msg),
  waitForTokenRefresh: () => waitForTokenRefresh(),
};

type WorkerRequestMessage =
  | { type: 'sync'; token: string }
  | { type: 'token'; token: string };

export function isWorkerRequestMessage(data: unknown): data is WorkerRequestMessage {
  return (
    typeof data === 'object' && data !== null &&
    'type' in data && (data.type === 'sync' || data.type === 'token') &&
    'token' in data && typeof data.token === 'string'
  );
}

// Guard so the module can be imported in node-based unit tests (vitest), where
// `self` does not exist. In a real worker `self` is always defined, so the
// listener registration is unchanged.
if (typeof self !== 'undefined') {
self.addEventListener('message', async (e: MessageEvent) => {
  if (!isWorkerRequestMessage(e.data)) return;
  const { type, token } = e.data;

  if (type === 'token') {
    currentToken = token;
    if (tokenRefreshResolver) {
      tokenRefreshResolver(true);
      tokenRefreshResolver = null;
    }
    return;
  }

  if (type !== 'sync') return;
  if (isBusy) { self.postMessage({ type: 'SYNC_BUSY' }); return; }
  if (!token) { self.postMessage({ type: 'SYNC_NO_TOKEN' }); return; }

  currentToken = token;
  isBusy = true;
  try {
    await startProSync();
  } finally {
    isBusy = false;
  }
});
}

// Resolves after `ms`, used as the exponential backoff between transient
// retries. setTimeout is available in the worker scope.
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Transient HTTP statuses worth retrying: 429 (rate limit) and 5xx server
// errors, per Google API guidance. Other statuses (2xx, 4xx) are not retried.
// A 403 is only transient when its JSON body identifies a Drive rate limit
// (see isDriveRateLimitResponse).
export function isTransientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

// True when a Drive error body reports a rate-limit reason (usage limits).
// Any parse failure means we cannot confirm a rate limit, so callers treat
// the response as non-transient (fail as before) instead of guessing.
function isDriveRateLimitBody(bodyText: string): boolean {
  try {
    const parsed = JSON.parse(bodyText) as { error?: { errors?: Array<{ reason?: unknown }> } };
    const errors = parsed?.error?.errors;
    return (
      Array.isArray(errors) &&
      errors.some((e) => {
        if (e === undefined || e === null) return false;
        const reason = e.reason;
        return typeof reason === 'string' && DRIVE_RATE_LIMIT_REASONS.has(reason);
      })
    );
  } catch {
    return false;
  }
}

// Decides whether a 403 is a retryable Drive rate limit. The body is read once
// via a clone so the response passed back to the call site keeps its body
// intact. Body/parse failures fall back to "not a rate limit": a 403 we cannot
// identify is returned as-is, matching the pre-upgrade behavior.
async function isDriveRateLimitResponse(ctx: string, res: Response): Promise<boolean> {
  try {
    const bodyText = await res.clone().text();
    return isDriveRateLimitBody(bodyText);
  } catch (err) {
    logWorkerError('proSync/' + ctx, { status: res.status, kind: 'rate-limit-body' }, err, 'warn');
    return false;
  }
}

// Retry-After as <delay-seconds> (RFC 9110). The HTTP-date form and malformed
// values fall back to the regular exponential backoff.
function parseRetryAfterSeconds(res: Response): number | null {
  const raw = res.headers.get('Retry-After');
  if (raw === null || raw.trim() === '') return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

// fetch() wrapper that applies the shared timeout and classifies transport
// failures (network / timeout / abort). HTTP status is still the caller's job.
// Transient statuses (429 / 5xx, plus 403 whose body reports a Drive rate
// limit) are retried with bounded exponential backoff + jitter, honoring the
// Retry-After header (capped at MAX_RETRY_DELAY_MS), max 3 attempts; 401 is
// returned untouched so the call site's token-refresh flow
// (refreshTokenAndRetry) keeps working, and aborted/timeout fetches are never
// retried.
export async function fetchDrive(ctx: string, token: string, url: URL): Promise<Response> {
  let attempt = 0;
  while (true) {
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(SYNC_FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      const kind = classifyWorkerError(err);
      if (kind === 'abort') {
        logWorkerError('proSync/' + ctx, { kind }, err, 'warn');
        throw new WorkerAbortError(`aborted during ${ctx}`);
      }
      if (kind === 'timeout') {
        logWorkerError('proSync/' + ctx, { kind, timeoutMs: SYNC_FETCH_TIMEOUT_MS }, err, 'error');
      } else {
        logWorkerError('proSync/' + ctx, { kind }, err, 'error');
      }
      throw err;
    }

    if (res.ok || attempt >= MAX_TRANSIENT_RETRIES) {
      return res;
    }

    // 429/5xx are transient by status alone; a 403 is transient only when its
    // JSON body identifies a Drive rate limit (rateLimitExceeded /
    // userRateLimitExceeded). Other 403s (permissions…) are not retried.
    const transient =
      isTransientStatus(res.status) ||
      (res.status === 403 && (await isDriveRateLimitResponse(ctx, res)));
    if (!transient) {
      return res;
    }

    const backoffMs = TRANSIENT_RETRY_BASE_DELAY_MS * 2 ** attempt;
    const retryAfterMs = parseRetryAfterSeconds(res);
    const cappedRetryAfterMs = retryAfterMs === null ? null : Math.min(retryAfterMs * 1000, MAX_RETRY_DELAY_MS);
    const jitterMs = Math.floor(Math.random() * (RETRY_JITTER_MAX_MS + 1));
    const delayMs = (cappedRetryAfterMs ?? backoffMs) + jitterMs;
    logWorkerError(
      'proSync/' + ctx,
      {
        kind: res.status === 429 || res.status === 403 ? 'rate-limit' : 'server',
        status: res.status,
        attempt: attempt + 1,
        delayMs,
        ...(cappedRetryAfterMs !== null ? { retryAfterMs: cappedRetryAfterMs } : {}),
        jitterMs,
      },
      new Error(`transient HTTP ${res.status}, retrying in ${delayMs}ms`),
      'warn'
    );
    await delay(delayMs);
    attempt += 1;
  }
}

// Parse a Drive JSON response, surfacing malformed bodies as a logged failure
// instead of an unhandled rejection that aborts the whole sync.
async function parseDriveJson<T = Record<string, unknown>>(ctx: string, res: Response): Promise<T> {
  try {
    return await res.json();
  } catch (err) {
    logWorkerError('proSync/' + ctx, { status: res.status, kind: 'parse' }, err, 'error');
    throw err;
  }
}

async function startProSync() {
  if (!currentToken) return;
  try {
    const tokenState = await db.syncState.get('startPageToken');

    if (!tokenState || !tokenState.value) {
      await performFullSync();
    } else {
      await performDeltaSync(tokenState.value as string);
    }
  } catch (err) {
    // Safety net for the Dexie read above and any error that escaped the
    // per-function handlers. We still inform the main thread.
    logWorkerError('proSync/start', {}, err, 'error');
    self.postMessage({ type: 'SYNC_ERROR' });
  }
}

async function performFullSync() {
  if (!currentToken) return;
  let startToken = '';

  // Retry the whole pass only when the startPageToken fetch hits 401 and the
  // main thread successfully refreshes the token.
  let retryFullSync = true;
  while (retryFullSync) {
    retryFullSync = false;

    try {
      const tokenUrl = new URL('https://www.googleapis.com/drive/v3/changes/startPageToken');
      const tokenRes = await fetchDrive('startPageToken', currentToken, tokenUrl);

      if (tokenRes.status === 401) {
        if (!(await refreshTokenAndRetry(syncRetry, syncRetryDeps, 'full-sync/startPageToken'))) return;
        retryFullSync = true;
        continue;
      }
      if (tokenRes.ok) {
        const tokenData = await parseDriveJson<{ startPageToken: string }>('startPageToken', tokenRes);
        startToken = tokenData.startPageToken;
      }
    } catch (err) {
      if (err instanceof WorkerAbortError) return;
      logWorkerError('proSync/full-sync', { phase: 'startPageToken' }, err, 'error');
      return;
    }

    let pageToken: string | undefined = undefined;
    try {
      do {
        const url = new URL('https://www.googleapis.com/drive/v3/files');
        url.searchParams.append('q', getAudioQuery());
        url.searchParams.append('fields', 'nextPageToken,files(id,name,mimeType,parents,size,modifiedTime)');
        url.searchParams.append('pageSize', '1000');
        if (pageToken) url.searchParams.append('pageToken', pageToken);

        const res = await fetchDrive('files', currentToken, url);

        if (!res.ok) {
          if (res.status === 401) {
            if (await refreshTokenAndRetry(syncRetry, syncRetryDeps, 'full-sync/files')) continue;
          }
          break;
        }

        const data = await parseDriveJson<{ files?: DriveFile[]; nextPageToken?: string }>('files', res);

        const rawFiles = data.files || [];
        const { valid: validFiles, skippedCount } = partitionValidFiles(rawFiles);
        // A page with unpersistable files is not a failure of this sync pass,
        // but dropping them silently hides data-loss from the user; emit one
        // summary line per page instead of spamming one line per file.
        if (skippedCount > 0) {
          logWorkerError(
            'proSync/full-sync/files',
            { kind: 'skip', skippedCount, total: rawFiles.length },
            new Error(`${skippedCount} file(s) skipped: missing id`),
            'warn'
          );
        }

        const filesToInsert = validFiles.map((f: DriveFile) =>
          toDriveFileRow(f, f.mimeType === FOLDER_MIME)
        );

        if (filesToInsert.length > 0) {
          try {
            await db.files.bulkPut(filesToInsert);
            self.postMessage({ type: 'SYNC_PROGRESS' });
          } catch (err) {
            logWorkerError('proSync/full-sync', { phase: 'bulkPut', count: filesToInsert.length }, err, 'error');
            break;
          }
        }

      pageToken = data.nextPageToken ?? '';
      } while (pageToken);
    } catch (err) {
      if (err instanceof WorkerAbortError) return;
      logWorkerError('proSync/full-sync', { phase: 'files' }, err, 'error');
    }
  }

  if (startToken) {
    try {
      await db.syncState.put({ key: 'startPageToken', value: startToken });
    } catch (err) {
      logWorkerError('proSync/full-sync', { phase: 'saveStartToken' }, err, 'error');
    }
  }

  self.postMessage({ type: 'SYNC_COMPLETE' });
}

async function performDeltaSync(startPageToken: string) {
  if (!currentToken) return;
  let pageToken = startPageToken;
  let newStartPageToken = startPageToken;
  // Files skipped because they lack a usable id, accumulated across all pages
  // of this delta run and reported as one summary line at the end.
  let skippedDeltaFiles = 0;

  try {
    do {
      const url = new URL('https://www.googleapis.com/drive/v3/changes');
      url.searchParams.append('pageToken', pageToken);
      url.searchParams.append('fields', 'nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,parents,size,modifiedTime,trashed))');

      const res = await fetchDrive('changes', currentToken, url);

      if (!res.ok) {
        if (res.status === 410) {
          syncRetry.count = 0;
          try {
            await db.syncState.delete('startPageToken');
          } catch (err) {
            logWorkerError('proSync/delta-sync', { phase: 'deleteStartToken' }, err, 'error');
          }
          await performFullSync();
          return;
        }
        if (res.status === 401) {
          if (await refreshTokenAndRetry(syncRetry, syncRetryDeps, 'delta-sync/changes')) continue;
        }
        break;
      }

      const data = await parseDriveJson<DriveChangesList>('changes', res);

      const changes = data.changes || [];
      let hasValidChanges = false;

      for (const change of changes) {
        try {
          if (change.removed || (change.file && change.file.trashed)) {
            await db.files.delete(change.fileId!);
            hasValidChanges = true;
          } else if (change.file) {
            const file = change.file;
            // A change whose file lacks an id cannot be persisted; skip it
            // (per-change isolation, matching the try/catch below). The count
            // is accumulated across pages and reported in one summary line
            // after the pagination loop.
            if (!isValidDriveFile(file)) { skippedDeltaFiles += 1; continue; }
            const isFolder = file.mimeType === FOLDER_MIME;

            if (isFolder || isAudioFile(file.mimeType!, file.name!)) {
              await db.files.put(toDriveFileRow(file, isFolder));
              hasValidChanges = true;
            }
          }
        } catch (err) {
          // One bad change must not abort the whole delta batch.
          logWorkerError('proSync/delta-sync', { phase: 'applyChange', fileId: change.fileId }, err, 'error');
        }
      }

      if (data.newStartPageToken) {
        newStartPageToken = data.newStartPageToken;
      }
      pageToken = data.nextPageToken ?? '';

      if (hasValidChanges) {
        self.postMessage({ type: 'SYNC_PROGRESS' });
      }
    } while (pageToken);

    // One summary line per delta run (not per skipped file) so a library with
    // missing-id files is never silently incomplete.
    if (skippedDeltaFiles > 0) {
      logWorkerError(
        'proSync/delta-sync/changes',
        { kind: 'skip', skippedCount: skippedDeltaFiles },
        new Error(`${skippedDeltaFiles} file(s) skipped: missing id`),
        'warn'
      );
    }

    if (newStartPageToken !== startPageToken) {
      try {
        await db.syncState.put({ key: 'startPageToken', value: newStartPageToken });
      } catch (err) {
        logWorkerError('proSync/delta-sync', { phase: 'saveStartToken' }, err, 'error');
      }
      self.postMessage({ type: 'SYNC_COMPLETE' });
    }
  } catch (err) {
    if (err instanceof WorkerAbortError) return;
    logWorkerError('proSync/delta-sync', { phase: 'changes' }, err, 'error');
  }
}
