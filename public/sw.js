// DrPlay Service Worker
// Intercepts /drive-stream/{fileId} and proxies to Google Drive API with Authorization header
// NOTE: '/drive-stream/' prefix must match src/utils/streamPrefetcher.ts DRIVE_STREAM_PREFIX

let accessToken = '';

// How long a 401-hit stream waits for the main thread to push a fresh token
// before giving up and returning the original 401. Rationale:
// - A Google OAuth refresh roundtrip here completes in ~0.5-2s on a healthy
//   network, so 10s covers it ~5-10x.
// - The refresh itself is bounded by REFRESH_TIMEOUT_MS (15s) in apiClient;
//   waiting longer would hold the <audio> fetch hostage on a dead network for
//   the full refresh bound. 10s < 15s: on a real network stall the stream
//   fails 5s earlier, which is strictly no worse than today's immediate 401.
const SW_TOKEN_WAIT_TIMEOUT_MS = 10_000;

// Waiters for 401-recovery retries. Each entry is a callback that resolves its
// own promise once the module-level accessToken actually differs from the
// token that produced the 401; callbacks remove themselves on resolution or
// timeout, so several concurrent /drive-stream/ requests can wait
// independently and all be woken by a single UPDATE_TOKEN.
let tokenWaiters = new Set();

// Notify every open window that the SW's token is stale so the main thread
// can refresh it and push UPDATE_TOKEN back (see useServiceWorker.ts). The
// message carries no token, so it cannot leak credentials.
async function notifyClients(message) {
  try {
    const clientsList = await self.clients.matchAll({ type: 'window' });
    for (const client of clientsList) {
      try {
        client.postMessage(message);
      } catch (err) {
        // postMessage to a closing client throws; never break the notify loop.
        console.warn('SW notifyClients postMessage failed', err);
      }
    }
  } catch (err) {
    console.warn('SW notifyClients matchAll failed', err);
  }
}

// Resolves true when accessToken changes to something different from
// staleToken before the timeout; resolves false on timeout (the caller falls
// back to the original 401 response).
function waitForTokenChange(staleToken) {
  // Token may already have changed between the 401 and registration (another
  // concurrent request's refresh landed); retry immediately in that case.
  if (accessToken !== staleToken) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      tokenWaiters.delete(notify);
      resolve(false);
    }, SW_TOKEN_WAIT_TIMEOUT_MS);
    const notify = () => {
      if (accessToken !== staleToken) {
        clearTimeout(timer);
        tokenWaiters.delete(notify);
        resolve(true);
      }
    };
    tokenWaiters.add(notify);
  });
}

// MIME override for playable extensions. The SW cannot import TS modules, so
// this is an independent copy of src/utils/audioFormat.ts
// AUDIO_EXTENSION_TO_MIME — src/utils/swMime.test.ts guards the two in sync.
const EXTENSION_TO_MIME = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  aac: 'audio/aac',
  opus: 'audio/opus'
};
const EXT_QUERY_PARAM = 'ext';
// Lowercase alphanumeric, 2-5 chars — rejects "..", "MP3", oversized junk.
const EXT_PATTERN = /^[a-z0-9]{2,5}$/;

// Drive serves app-uploaded files as application/octet-stream, which <audio>
// refuses to decode (SRC_NOT_SUPPORTED). When the URL carries ?ext=<playable>,
// rebuild the response with the correct Content-Type around the SAME body
// stream — Range/seek/streaming behaviour is untouched (status, Content-Range,
// Content-Length and every other header are copied). Any missing/invalid ext
// or non-2xx response passes through unchanged (backward compatible).
function overrideContentType(response, ext) {
  if (!EXT_PATTERN.test(ext)) return response;
  const mime = EXTENSION_TO_MIME[ext];
  if (!mime || !response.ok || !response.body) return response;
  try {
    const headers = new Headers(response.headers);
    headers.set('Content-Type', mime);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  } catch (err) {
    console.warn('SW content-type override failed', err);
    return response;
  }
}

// Drive's CORS policy does not expose Content-Range (only Content-Disposition
// is listed in its Access-Control-Expose-Headers), so a 206 proxied through
// the SW arrives with that header stripped. A 206 without Content-Range
// violates RFC 7233, and Chromium refuses to decode such a response in
// <audio> (SRC_NOT_SUPPORTED, code=4). The range can be reconstructed exactly
// from the request's Range header plus the body length in Content-Length,
// which CORS does allow through.
const RANGE_PATTERN = /^bytes=(\d+)-(\d*)$/;
const TOTAL_SIZE_CACHE_LIMIT = 100;
// Full resource size learned from open-ended ranges (bytes=0- / bytes=S-),
// where total = start + Content-Length is always exact. Closed ranges
// (bytes=S-E) — media seeks or metadata prefetches — are only annotated when
// this cache already holds the total: synthesizing a wrong total for a
// metadata prefetch (bytes=0-131071 on a 291MB file) would corrupt it.
const totalSizeByFileId = new Map();

// Returns { start, end } (end === null for open-ended ranges) or null when
// the Range header is missing, unparseable, or out of order.
function parseRangeHeader(range) {
  const match = RANGE_PATTERN.exec(range);
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] === '' ? null : Number(match[2]);
  if (!Number.isSafeInteger(start)) return null;
  if (end !== null && (!Number.isSafeInteger(end) || end < start)) return null;
  return { start, end };
}

function rememberTotalSize(fileId, total) {
  totalSizeByFileId.set(fileId, total);
  // Bounded cache: evict the oldest entry so a long session across many
  // files cannot grow the SW's memory without limit.
  if (totalSizeByFileId.size > TOTAL_SIZE_CACHE_LIMIT) {
    const oldest = totalSizeByFileId.keys().next().value;
    if (oldest !== undefined) totalSizeByFileId.delete(oldest);
  }
}

// Rebuilds the response with the given Content-Range, preserving the body
// stream, status and every other header.
function withContentRange(response, contentRange) {
  const headers = new Headers(response.headers);
  headers.set('Content-Range', contentRange);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

// Reconstructs Content-Range on a 206 that lost it to the CORS filter.
// Returns the original response unchanged whenever the range cannot be
// reconstructed (non-206 status, header already present, no Range header,
// unparseable range, unknown total for a closed range) — pass-through in
// every one of those cases.
function ensureContentRange(fileId, response, request) {
  if (response.status !== 206) return response;
  if (response.headers.get('Content-Range')) return response;
  const contentLength = Number(response.headers.get('Content-Length'));
  let range;
  try {
    range = parseRangeHeader(request.headers.get('Range'));
  } catch (err) {
    console.warn('SW ensureContentRange parse failed, passing through', err);
    return response;
  }
  if (!range) return response;
  if (range.end === null) {
    // Open-ended range: total = start + body length is exact.
    if (!Number.isSafeInteger(contentLength) || contentLength < 1) return response;
    const total = range.start + contentLength;
    rememberTotalSize(fileId, total);
    return withContentRange(
      response,
      `bytes ${String(range.start)}-${String(total - 1)}/${String(total)}`
    );
  }
  // Closed range: annotate only when the true total is already known; a
  // range ending at or past EOF is left untouched.
  const total = totalSizeByFileId.get(fileId);
  if (!Number.isSafeInteger(total) || range.end >= total) return response;
  return withContentRange(
    response,
    `bytes ${String(range.start)}-${String(range.end)}/${String(total)}`
  );
}

self.addEventListener('install', (event) => {
  // Bỏ qua trạng thái waiting, active ngay lập tức
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Claim các client hiện tại ngay lập tức để không cần reload trang
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  // Lắng nghe token từ App.tsx gửi sang
  if (event.data && event.data.type === 'UPDATE_TOKEN') {
    accessToken = event.data.token;
    // Wake every 401 waiter; each one checks whether ITS stale token changed.
    tokenWaiters.forEach((notify) => notify());
  }
});

// Proxy a /drive-stream/ request to Google Drive, retrying exactly once with a
// fresh token if Google answers 401 (the token went stale mid-stream). A
// second 401 or a timeout waiting for the refresh returns the ORIGINAL 401,
// so the failure is never worse than the pre-fix behavior.
async function fetchDriveStream(event, driveUrl) {
  const buildRequest = () => {
    // Giữ nguyên các header gốc (đặc biệt là header Range: bytes=...)
    const headers = new Headers(event.request.headers);
    headers.set('Authorization', `Bearer ${accessToken}`);
    return new Request(driveUrl, {
      method: event.request.method,
      headers,
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store'
    });
  };

  const response = await fetch(buildRequest());

  if (response.status === 401 && accessToken) {
    const staleToken = accessToken;
    await notifyClients({ type: 'SW_TOKEN_EXPIRED' });
    const refreshed = await waitForTokenChange(staleToken);
    // Timeout, logout (empty token), or no real change -> keep original 401.
    if (!refreshed || !accessToken) return response;
    const retryResponse = await fetch(buildRequest());
    // Retried once with a fresh token; a second 401 is final (no loop).
    return retryResponse.status === 401 ? response : retryResponse;
  }

  return response;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Kiểm tra xem đây có phải là request ảo để stream nhạc không
  if (url.pathname.startsWith('/drive-stream/')) {
    const fileId = url.pathname.replace('/drive-stream/', '');
    if (!fileId) return;

    if (!accessToken) {
      return event.respondWith(new Response('Unauthorized - Missing Token in SW', { status: 401 }));
    }

    const ext = url.searchParams.get(EXT_QUERY_PARAM);
    const driveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;

    // Thực thi fetch trực tiếp lên Google Drive và trả về cho thẻ audio
    event.respondWith(
      fetchDriveStream(event, driveUrl).then((response) => {
        // Rebuild order matters: synthesize Content-Range FIRST (headers may
        // need it), then let overrideContentType fix the MIME on top.
        const rangeAware = ensureContentRange(fileId, response, event.request);
        return overrideContentType(rangeAware, ext ?? '');
      })
    );
  }
});
