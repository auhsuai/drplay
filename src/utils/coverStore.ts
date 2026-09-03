// S4: push compressed covers to the Rust disk cache via the custom drplay://
// scheme (protocol/mod.rs contract) and build the GET URLs the UI renders.
// - GET  drplay://cover?id={fileId}&thumb=true|false -> 200 jpeg / 204 NoCover
// - POST drplay://cover/{fileId}?thumb=true|false   -> raw binary body
// Every POST failure is non-fatal (warn + drop); the UI keeps working and the
// cover simply stays out of the Rust cache until the next network parse.
import { createSemaphore } from "./asyncLimit";
import { captureError } from "./errorLog";
import { classifyMetaError } from "./metadata/cache";

const COVER_STORE_MODULE = "coverStore";
const COVER_SCHEME = "drplay://";
const COVER_GET_PATH = "cover";
const COVER_POST_PATH_PREFIX = "cover/";
const POST_TIMEOUT_MS = 10_000;
const DEFAULT_COVER_MIME = "image/jpeg";
// 5xx (DiskWrite -> 500) and 429 are transient; one retry is enough for a
// local disk write. 4xx (bad id / empty / oversized payload) are permanent.
const POST_MAX_RETRIES = 1;
const POST_MAX_CONCURRENT = 3;
const THUMB_TRUE = "true";
const THUMB_FALSE = "false";

// ---- App-wide throttle: at most POST_MAX_CONCURRENT cover POSTs in flight.
const postSemaphore = createSemaphore(POST_MAX_CONCURRENT);
// Same (id, variant) already being posted -> skip the duplicate entirely
// (a cover grid + NowPlaying can compress the same track concurrently).
const inflightPostKeys = new Set<string>();
// Chromium/WebView2 rejects the custom drplay:// scheme at the network stack
// (ERR_UNKNOWN_URL_SCHEME -> TypeError) before any request reaches the Rust
// handler — in such runtimes EVERY POST fails identically, so after the first
// such failure the whole upload path is disabled (no per-track warn noise).
let schemeUnavailable = false;
// Transient-outage marker: a POST that failed with a network-level TypeError
// WHILE the browser reported offline (navigator.onLine === false) says nothing
// about the scheme's health, so it must not kill uploads for the session.
// Uploads stay paused (no per-track warn noise) until onLine reports the
// connection back; there is deliberately no `online` event listener — the
// check happens at the next POST call, matching this module's fire-and-forget
// call pattern.
let offlineSuspension = false;

function isBrowserOffline(): boolean {
  // Only an explicit onLine === false counts as offline. A missing navigator
  // or undefined onLine (older WebViews, non-browser runtimes) must read as
  // "online" so genuine scheme-dead failures still latch permanently — hence
  // the explicit comparison instead of a truthiness check.
  const onLine: boolean | undefined =
    typeof navigator === "undefined" ? undefined : navigator.onLine;
  return onLine === false;
}

function postKey(fileId: string, thumb: boolean): string {
  return `${thumb ? "t" : "f"}:${fileId}`;
}

/**
 * GET URL for the UI <img src>: `drplay://cover?id={fileId}&thumb={bool}`.
 * Matches protocol/mod.rs GET /cover?id= (thumb flips the t/f disk subtree).
 */
export function buildCoverUrl(fileId: string, thumb: boolean): string {
  return `${COVER_SCHEME}${COVER_GET_PATH}?id=${encodeURIComponent(fileId)}&thumb=${thumb ? THUMB_TRUE : THUMB_FALSE}`;
}

/**
 * Blob URL for in-memory cover bytes (Fix G). drplay:// (Rust disk cache) is
 * the PRIMARY cover source; this fallback exists only for runtimes where the
 * custom scheme is unavailable — a dev browser rejects it with
 * ERR_UNKNOWN_URL_SCHEME before any fetch happens. The bytes come from the
 * very picture metadata already parsed, so no extra network/disk read is
 * needed. Returns null when there are no bytes (nothing to fall back to —
 * the caller keeps its icon).
 * The blob is intentionally NOT revoked: covers are small (≤256px thumb /
 * ≤1000px full) and revoking while an <img> may still reference it risks
 * broken covers; the browser drops blob URLs on page unload.
 */
export function buildCoverBlobUrl(
  pictureData: Uint8Array | null,
  pictureFormat?: string,
): string | null {
  if (!pictureData || pictureData.byteLength === 0) return null;
  return URL.createObjectURL(
    new Blob([pictureData], { type: pictureFormat ?? DEFAULT_COVER_MIME }),
  );
}

function buildPostUrl(fileId: string, thumb: boolean): string {
  return `${COVER_SCHEME}${COVER_POST_PATH_PREFIX}${encodeURIComponent(fileId)}?thumb=${thumb ? THUMB_TRUE : THUMB_FALSE}`;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * Fire-and-forget upload of one cover variant to the Rust disk cache. Never
 * throws: every failure is logged as a warn (source=coverStore) and dropped —
 * the caller (metadata hot path) must never be blocked by a disk hiccup.
 */
export async function postCoverToCache(
  fileId: string,
  thumb: boolean,
  bytes: Uint8Array,
): Promise<void> {
  if (schemeUnavailable || bytes.byteLength === 0) return;
  if (offlineSuspension) {
    // A previous failure happened while offline. Stay paused until onLine
    // reports the connection back; then clear the pause and let THIS call be
    // the retry probe. If the scheme is genuinely dead, the next TypeError
    // observed while online re-latches schemeUnavailable below.
    if (isBrowserOffline()) return;
    offlineSuspension = false;
  }
  const key = postKey(fileId, thumb);
  if (inflightPostKeys.has(key)) return;
  inflightPostKeys.add(key);
  try {
    await postSemaphore.run(() => performPostWithRetry(fileId, thumb, bytes));
  } finally {
    inflightPostKeys.delete(key);
  }
}

async function performPostWithRetry(
  fileId: string,
  thumb: boolean,
  bytes: Uint8Array,
): Promise<void> {
  let retriesLeft = POST_MAX_RETRIES;
  for (;;) {
    try {
      const status = await performPostOnce(fileId, thumb, bytes);
      if (status === 200) return;
      if (isRetryableStatus(status) && retriesLeft > 0) {
        retriesLeft -= 1;
        continue;
      }
      logCoverPostError(fileId, thumb, null, status);
      return;
    } catch (e: unknown) {
      logCoverPostError(fileId, thumb, e);
      return;
    }
  }
}

async function performPostOnce(
  fileId: string,
  thumb: boolean,
  bytes: Uint8Array,
): Promise<number> {
  let response: Response;
  try {
    response = await fetch(buildPostUrl(fileId, thumb), {
      method: "POST",
      body: bytes,
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
  } catch (e) {
    // A TypeError means the request never reached the Rust handler. What it
    // means for the future of this upload path depends on navigator.onLine AT
    // THE TIME OF FAILURE: while offline, fetch rejects with the same
    // "Failed to fetch" TypeError even though the scheme is healthy — that is
    // a transient outage, so suspend only until connectivity returns. A
    // TypeError observed WHILE ONLINE is the scheme being rejected before the
    // request could be sent (Chromium: ERR_UNKNOWN_URL_SCHEME), which is
    // permanent for the runtime — latch the path off as before.
    // A TimeoutError (DOMException) is NOT a scheme problem in either case,
    // so it must not disable the path (the scheme worked, the disk write was
    // just slow).
    if (e instanceof TypeError) {
      if (isBrowserOffline()) {
        offlineSuspension = true;
      } else {
        schemeUnavailable = true;
      }
    }
    throw e;
  }
  return response.status;
}

function logCoverPostError(
  fileId: string,
  thumb: boolean,
  e: unknown,
  status?: number,
): void {
  const variant = thumb ? "thumb" : "full";
  if (status !== undefined) {
    void captureError({
      level: "warn",
      source: COVER_STORE_MODULE,
      message: `cover-post-failed (fileId=${fileId}, variant=${variant}, status=${String(status)})`,
      kind: "CoverPostStatus",
    });
    return;
  }
  void captureError({
    level: "warn",
    source: COVER_STORE_MODULE,
    message: `cover-post-failed (fileId=${fileId}, variant=${variant}): ${e instanceof Error ? e.message : String(e)}`,
    kind: classifyMetaError(e).name,
  });
}
