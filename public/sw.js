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
  m4a: 'audio/mp4',
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
const TOTAL_SIZE_CACHE_LIMIT = 1000;
// 1000 (was 100): entries are small Map items (~a few KB total), so a higher
// limit is cheap. In long sessions (>100 files), an early file's total could
// already have been evicted by the time the user seeks back to it; the SW then
// cannot annotate a closed-range 206 with Content-Range and Chromium fails to
// decode it (SRC_NOT_SUPPORTED, code=4) — verified experimentally.
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
  const changed = totalSizeByFileId.get(fileId) !== total;
  totalSizeByFileId.set(fileId, total);
  if (changed) persistTotalSize(fileId, total); // durable copy (byte-cache contract 3)
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

// ---------------------------------------------------------------------------
// Byte-range cache (Slice 1) — IndexedDB store inside the SW.
// Why IndexedDB instead of the HTTP cache: the Drive fetch is forced to
// `cache: 'no-store'` (Chromium bug 1026876 — see fetchDriveStream below), so
// bytes never land in any HTTP cache and every play/seek re-downloads. This
// store gives <audio> a second, durable source: fully covered ranges are
// served from IDB with zero Drive round-trips, misses fall through to the
// legacy proxy path unchanged and write their bytes through in the
// background. All failures degrade to the legacy pass-through (never crash,
// never worse than before the cache existed).

// Aligned chunk size. 256KB balances seek granularity against per-chunk IDB
// overhead; the metadata path (driveRangeChunkFetcher.ts, 64KB) is untouched.
const BYTE_CHUNK_SIZE = 256 * 1024;
// 512MB durable cap, LRU by last access: exceeding it evicts the
// least-recently-accessed chunks first. Overridable in tests via a seam.
const BYTE_CACHE_CAP_BYTES = self.DRPLAY_BYTE_CACHE_CAP || 512 * 1024 * 1024;
const BYTE_CACHE_DB_NAME = 'drplay-bytes';
const BYTE_CACHE_DB_VERSION = 1;
// Store layout: "chunks" key `${fileId}:${chunkIndex}` -> ArrayBuffer holding
// the chunk PREFIX stored so far (bytes are immutable file content, so a
// longer prefix always dominates a shorter one); "meta" same key ->
// { fileId, chunk, bytes, lastAccess }; "sizes" fileId -> total resource size
// (durable twin of totalSizeByFileId, consulted when the in-memory LRU evicts).
const BYTE_STORE_CHUNKS = 'chunks';
const BYTE_STORE_META = 'meta';
const BYTE_STORE_SIZES = 'sizes';

let byteCacheDbPromise = null;
// Chunk keys with a write currently in flight — coalesces parallel
// write-throughs for the same chunk (same-fileId races stay safe).
const byteCachePendingWrites = new Set();

// Classified logging — context carries module + operation; never the token.
function byteCacheLog(level, context, err) {
  console[level](`SW byte-cache ${context}`, err);
}

function openByteCacheDb() {
  if (byteCacheDbPromise) return byteCacheDbPromise;
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new DOMException('indexedDB unavailable', 'NotSupportedError'));
  }
  byteCacheDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(BYTE_CACHE_DB_NAME, BYTE_CACHE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(BYTE_STORE_CHUNKS)) {
        db.createObjectStore(BYTE_STORE_CHUNKS);
      }
      if (!db.objectStoreNames.contains(BYTE_STORE_META)) {
        db.createObjectStore(BYTE_STORE_META);
      }
      if (!db.objectStoreNames.contains(BYTE_STORE_SIZES)) {
        db.createObjectStore(BYTE_STORE_SIZES);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  // Do not memoize failures: a transient open error (private mode, upgrade in
  // flight) must not disable the cache for the whole SW lifetime. A rejected
  // promise is replaced on the next call by a fresh open attempt.
  byteCacheDbPromise.catch(() => {
    byteCacheDbPromise = null;
  });
  return byteCacheDbPromise;
}

// Opens a readwrite transaction; returns { db, tx, done } where `done`
// resolves true on commit and false on abort/error, or null when the open or
// transaction creation failed (caller degrades to the legacy path).
function byteCacheRw(db, storeNames, context) {
  let tx;
  try {
    tx = db.transaction(storeNames, 'readwrite');
  } catch (err) {
    byteCacheLog('warn', `${context} transaction create failed`, err);
    return null;
  }
  const done = new Promise((resolve) => {
    tx.oncomplete = () => resolve(true);
    tx.onabort = () => resolve(false);
    tx.onerror = () => resolve(false);
  });
  return { db, tx, done };
}

function chunkIndexOf(offset) {
  return Math.floor(offset / BYTE_CHUNK_SIZE);
}

function chunkKey(fileId, index) {
  return `${fileId}:${String(index)}`;
}

// Resolves an IDBRequest; rejections keep err.name intact for classification.
function idbDone(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function loadChunk(fileId, index) {
  let db;
  try {
    db = await openByteCacheDb();
  } catch (err) {
    byteCacheLog('warn', 'loadChunk open failed', err);
    return null;
  }
  let tx;
  try {
    tx = db.transaction([BYTE_STORE_CHUNKS, BYTE_STORE_META], 'readonly');
  } catch (err) {
    byteCacheLog('warn', 'loadChunk transaction failed', err);
    return null;
  }
  try {
    const key = chunkKey(fileId, index);
    // Both gets are issued synchronously so the tx stays active.
    const dataReq = tx.objectStore(BYTE_STORE_CHUNKS).get(key);
    const metaReq = tx.objectStore(BYTE_STORE_META).get(key);
    const [data, meta] = await Promise.all([idbDone(dataReq), idbDone(metaReq)]);
    if (!(data instanceof ArrayBuffer) || !meta) return null;
    return { data, meta };
  } catch (err) {
    byteCacheLog('warn', 'loadChunk read failed', err);
    return null;
  }
}

// LRU touch for one chunk (best-effort; a stale lastAccess only skews
// eviction order, never correctness) followed by a cap check.
async function touchAndEvict(fileId, index) {
  let db;
  try {
    db = await openByteCacheDb();
  } catch (err) {
    return; // open failure already warned elsewhere; stay silent here
  }
  const rw = byteCacheRw(db, [BYTE_STORE_META], 'touch');
  if (!rw) return;
  try {
    const key = chunkKey(fileId, index);
    const metaReq = rw.tx.objectStore(BYTE_STORE_META).get(key);
    const meta = await idbDone(metaReq);
    if (meta) {
      meta.lastAccess = Date.now();
      rw.tx.objectStore(BYTE_STORE_META).put(meta, key);
    }
    const ok = await rw.done;
    if (ok) await evictOverCap(rw.db);
  } catch (err) {
    byteCacheLog('warn', 'touch failed', err);
  }
}

// LRU eviction: sums meta.bytes and deletes least-recently-accessed chunks
// until the store fits under BYTE_CACHE_CAP_BYTES.
async function evictOverCap(db) {
  let tx;
  try {
    tx = db.transaction([BYTE_STORE_META, BYTE_STORE_CHUNKS], 'readwrite');
  } catch (err) {
    byteCacheLog('warn', 'evict transaction failed', err);
    return;
  }
  try {
    const allReq = tx.objectStore(BYTE_STORE_META).getAll();
    const all = await idbDone(allReq);
    const entries = (all || []).filter((m) => m && Number.isSafeInteger(m.bytes));
    const total = entries.reduce((sum, m) => sum + m.bytes, 0);
    if (total <= BYTE_CACHE_CAP_BYTES) return;
    const oldestFirst = [...entries].sort((a, b) => a.lastAccess - b.lastAccess);
    let over = total - BYTE_CACHE_CAP_BYTES;
    for (const meta of oldestFirst) {
      if (over <= 0) break;
      const key = chunkKey(meta.fileId, meta.chunk);
      tx.objectStore(BYTE_STORE_META).delete(key);
      tx.objectStore(BYTE_STORE_CHUNKS).delete(key);
      over -= meta.bytes;
    }
    await new Promise((resolve) => {
      tx.oncomplete = resolve;
      tx.onabort = resolve;
      tx.onerror = resolve;
    });
  } catch (err) {
    byteCacheLog('warn', 'evict failed', err);
  }
}

// Durable twin of totalSizeByFileId. Fire-and-forget: the in-memory Map stays
// the synchronous source of truth; IDB is only the recovery copy consulted
// when the in-memory entry has been evicted (byte-cache contract 3).
function persistTotalSize(fileId, total) {
  void (async () => {
    let db;
    try {
      db = await openByteCacheDb();
    } catch (err) {
      return; // no IDB — the in-memory Map still works
    }
    const rw = byteCacheRw(db, [BYTE_STORE_SIZES], 'persistTotalSize');
    if (!rw) return;
    try {
      rw.tx.objectStore(BYTE_STORE_SIZES).put(total, fileId);
      const ok = await rw.done;
      if (!ok) byteCacheLog('warn', 'persistTotalSize failed', rw.tx.error);
    } catch (err) {
      byteCacheLog('warn', 'persistTotalSize failed', err);
    }
  })();
}

// Loads the durable total for fileId when the in-memory LRU has evicted it.
// Returns undefined when nothing durable exists (caller keeps legacy path).
async function loadPersistedTotalSize(fileId) {
  let db;
  try {
    db = await openByteCacheDb();
  } catch (err) {
    return undefined; // degraded; read paths warn on their own
  }
  try {
    const tx = db.transaction([BYTE_STORE_SIZES], 'readonly');
    const req = tx.objectStore(BYTE_STORE_SIZES).get(fileId);
    const value = await idbDone(req);
    return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
  } catch (err) {
    byteCacheLog('warn', 'loadPersistedTotalSize failed', err);
    return undefined;
  }
}

// Stores one aligned chunk PREFIX with an extend-only merge: a shorter body
// never shrinks a longer stored prefix (chunk bytes are immutable file
// content, so the longer prefix dominates). Concurrent writes for the same
// chunk coalesce via byteCachePendingWrites.
async function storeChunk(fileId, chunkIndex, bytes) {
  const key = chunkKey(fileId, chunkIndex);
  if (byteCachePendingWrites.has(key)) return;
  byteCachePendingWrites.add(key);
  try {
    let db;
    try {
      db = await openByteCacheDb();
    } catch (err) {
      byteCacheLog('warn', 'storeChunk open failed', err);
      return;
    }
    const rw = byteCacheRw(db, [BYTE_STORE_CHUNKS, BYTE_STORE_META], 'storeChunk');
    if (!rw) return;
    try {
      const chunksStore = rw.tx.objectStore(BYTE_STORE_CHUNKS);
      const metaStore = rw.tx.objectStore(BYTE_STORE_META);
      const existingReq = chunksStore.get(key);
      const existing = await idbDone(existingReq);
      const existingLength =
        existing instanceof ArrayBuffer ? existing.byteLength : 0;
      if (bytes.byteLength <= existingLength) return; // extend-only merge
      // Always store a plain ArrayBuffer so loadChunk's instanceof check and
      // byte-exact reads stay simple (IDB structured-clones on put).
      const buffer =
        bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
          ? bytes.buffer
          : bytes.slice().buffer;
      chunksStore.put(buffer, key);
      metaStore.put(
        {
          fileId,
          chunk: chunkIndex,
          bytes: bytes.byteLength,
          lastAccess: Date.now()
        },
        key
      );
      const ok = await rw.done;
      if (!ok && rw.tx.error && rw.tx.error.name === 'QuotaExceededError') {
        byteCacheLog('warn', 'storeChunk quota — chunk dropped', rw.tx.error);
      } else if (!ok) {
        byteCacheLog('warn', 'storeChunk transaction failed', rw.tx.error);
      }
      if (ok) await evictOverCap(rw.db);
    } finally {
      byteCachePendingWrites.delete(key);
    }
  } catch (err) {
    if (err && err.name === 'QuotaExceededError') {
      byteCacheLog('warn', 'storeChunk quota — chunk dropped', err);
    } else {
      byteCacheLog('warn', 'storeChunk failed', err);
    }
  }
}

// Reads from a stream until at least `target` bytes are buffered or the
// stream ends; returns them merged into one Uint8Array (bounded memory:
// at most one chunk per call).
async function collectUpTo(stream, target) {
  const reader = stream.getReader();
  const parts = [];
  let received = 0;
  try {
    while (received < target) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      received += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (parts.length === 0) return new Uint8Array(0);
  if (parts.length === 1) return parts[0];
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  return merged;
}

// Consumes the cache branch of a tee'd 206 body and stores every chunk
// prefix it can reconstruct. A body starting mid-chunk has its head bytes
// DISCARDED: they are a chunk suffix and can never form a valid
// prefix-from-chunk-start (this is what keeps cached bytes byte-exact).
async function storeBodyChunks(fileId, start, stream) {
  const headSkip = start % BYTE_CHUNK_SIZE;
  let chunkIndex = chunkIndexOf(start);
  try {
    if (headSkip > 0) {
      const head = await collectUpTo(stream, headSkip);
      if (head.byteLength < headSkip) return; // body ended mid-chunk: nothing storeable
    }
    const chunkCap = chunkIndexOf(start) + 16384; // >4GB guard, then give up
    while (chunkIndex <= chunkCap) {
      const buffer = await collectUpTo(stream, BYTE_CHUNK_SIZE);
      if (buffer.byteLength === 0) return;
      await storeChunk(fileId, chunkIndex, buffer);
      if (buffer.byteLength < BYTE_CHUNK_SIZE) return; // EOF/partial tail stored
      chunkIndex += 1;
    }
  } catch (err) {
    if (err && err.name === 'QuotaExceededError') {
      byteCacheLog('warn', 'writeThrough quota — chunk dropped', err);
    } else {
      byteCacheLog('warn', 'writeThrough failed', err);
    }
  }
}

// Splits a cacheable 206 so the user-facing response streams at full speed
// while a background copy lands in IDB. Returns the user response (a tee'd
// branch with identical status/headers), or the original response untouched
// when the request/body is not cacheable.
function writeThroughToCache(event, fileId, request, response) {
  if (response.status !== 206 || !response.body) return response;
  let range;
  try {
    range = parseRangeHeader(request.headers.get('Range'));
  } catch (err) {
    byteCacheLog('warn', 'writeThrough range parse failed', err);
    return response;
  }
  if (!range) return response;
  let branches;
  try {
    branches = response.body.tee();
  } catch (err) {
    byteCacheLog('warn', 'tee failed', err);
    return response;
  }
  const [userBranch, cacheBranch] = branches;
  const writePromise = storeBodyChunks(fileId, range.start, cacheBranch);
  if (typeof event.waitUntil === 'function') {
    try {
      event.waitUntil(writePromise);
    } catch (err) {
      byteCacheLog('warn', 'waitUntil failed', err);
    }
  } else {
    void writePromise; // test sandbox: flushed explicitly by tests
  }
  return new Response(userBranch, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

// Assembles the cached 206 for [start, end] from stored chunk prefixes.
// Returns null when any covering chunk is missing or too short (partial
// coverage is a miss, never a broken hit).
async function buildCachedRangeResponse(fileId, start, end, ext) {
  const expected = end - start + 1;
  const firstChunk = chunkIndexOf(start);
  const lastChunk = chunkIndexOf(end);
  const parts = [];
  for (let index = firstChunk; index <= lastChunk; index++) {
    const stored = await loadChunk(fileId, index);
    if (!stored) return null;
    const chunkStart = index * BYTE_CHUNK_SIZE;
    const within = start > chunkStart ? start - chunkStart : 0;
    const needed =
      Math.min(end, chunkStart + BYTE_CHUNK_SIZE - 1) - chunkStart + 1 - within;
    if (stored.data.byteLength < within + needed) return null;
    parts.push(new Uint8Array(stored.data, within, needed));
  }
  const mime = EXTENSION_TO_MIME[ext] || 'application/octet-stream';
  const total = totalSizeByFileId.get(fileId);
  const headers = new Headers({
    'Content-Type': mime,
    'Content-Length': String(expected),
    'Accept-Ranges': 'bytes'
  });
  if (Number.isSafeInteger(total)) {
    headers.set(
      'Content-Range',
      `bytes ${String(start)}-${String(end)}/${String(total)}`
    );
  }
  for (const index of [firstChunk, lastChunk]) {
    void touchAndEvict(fileId, index); // LRU last-access, fire-and-forget
  }
  return new Response(new Blob(parts), { status: 206, headers });
}

// Cache-first serve. Returns a 206 only when the FULL requested range is
// covered by stored chunks AND the total size is known (Content-Range needs
// it; without it Chromium refuses to decode the response). Otherwise null →
// the caller falls through to the legacy Drive proxy unchanged.
async function serveFromByteCache(fileId, request, ext) {
  if (typeof indexedDB === 'undefined') return null;
  let range;
  try {
    range = parseRangeHeader(request.headers.get('Range'));
  } catch (err) {
    byteCacheLog('warn', 'serve range parse failed', err);
    return null;
  }
  if (!range) return null;
  // Recover the durable total when the in-memory LRU evicted it. This helps
  // both the cached serve below and the legacy Content-Range synthesis
  // downstream (byte-cache contract 3: seek survives eviction).
  if (!totalSizeByFileId.has(fileId)) {
    const persisted = await loadPersistedTotalSize(fileId);
    if (persisted !== undefined) totalSizeByFileId.set(fileId, persisted);
  }
  const total = totalSizeByFileId.get(fileId);
  if (!Number.isSafeInteger(total) || total < 1) return null;
  if (range.start >= total) return null;
  let end;
  if (range.end === null) {
    end = total - 1; // open-ended: serve the remaining tail from cache
  } else {
    if (range.end >= total) return null; // past-EOF probes → legacy path
    end = range.end;
  }
  try {
    return await buildCachedRangeResponse(fileId, range.start, end, ext);
  } catch (err) {
    byteCacheLog('warn', 'serveFromByteCache failed', err);
    return null;
  }
}

// End of byte-range cache section.

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
  } else if (event.data && event.data.type === 'PREFETCH_TRACK') {
    // Slice 2: warm the byte-cache for the next track (best-effort).
    const fileId = typeof event.data.fileId === 'string' ? event.data.fileId : '';
    if (!fileId || !accessToken) return;
    const prefetchPromise = prefetchTrackBytes(fileId);
    if (typeof event.waitUntil === 'function') {
      try {
        event.waitUntil(prefetchPromise);
      } catch (err) {
        byteCacheLog('warn', 'prefetch waitUntil failed', err);
      }
    } else {
      void prefetchPromise; // test sandbox: flushed explicitly by tests
    }
  }
});

// Streams the next track's open-ended range through the same proxy rules
// (no-store + backoff) and lands the bytes in the IDB cache via
// storeBodyChunks, so the later <audio> load is served with zero Drive
// round-trips. Learns the total size like ensureContentRange does — without
// it the closed/open cache-serve path would never trust the cached bytes.
async function prefetchTrackBytes(fileId) {
  try {
    const driveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
    const buildRequest = () => {
      const headers = new Headers();
      headers.set('Range', 'bytes=0-');
      headers.set('Authorization', `Bearer ${accessToken}`);
      return new Request(driveUrl, {
        method: 'GET',
        headers,
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store'
      });
    };
    const response = await fetchWithBackoff(buildRequest);
    if (!response.ok || !response.body) {
      byteCacheLog(
        'warn',
        'prefetch skipped (non-ok upstream)',
        new Error(`upstream status ${String(response.status)}`)
      );
      return;
    }
    const contentLength = Number(response.headers.get('Content-Length'));
    if (Number.isSafeInteger(contentLength) && contentLength >= 1) {
      rememberTotalSize(fileId, contentLength);
    }
    await storeBodyChunks(fileId, 0, response.body);
  } catch (err) {
    byteCacheLog('warn', 'prefetch failed', err);
  }
}

// Proxy a /drive-stream/ request to Google Drive, retrying exactly once with a
// fresh token if Google answers 401 (the token went stale mid-stream). A
// second 401 or a timeout waiting for the refresh returns the ORIGINAL 401,
// so the failure is never worse than the pre-fix behavior.

// Transient upstream failures worth a bounded retry: rate limit + gateway
// class. 401 has its own token-refresh recovery; other 4xx are final.
const SW_RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
// Bounded backoff (2 retries): ~one RTT, then a longer jitter catch.
const SW_RETRY_DELAYS_MS = [400, 1200];

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithBackoff(buildRequest) {
  let response = await fetch(buildRequest());
  for (let attempt = 0; attempt < SW_RETRY_DELAYS_MS.length; attempt++) {
    if (!SW_RETRYABLE_STATUS.has(response.status)) return response;
    await sleepMs(SW_RETRY_DELAYS_MS[attempt]);
    response = await fetch(buildRequest());
  }
  return response;
}

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
      cache: 'no-store',
      // Honor page-side aborts (seek/navigation) instead of finishing a
      // fetch nobody is reading anymore.
      signal: event.request.signal
    });
  };

  const response = await fetchWithBackoff(buildRequest);

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

// Order: cache-first serve → Drive fetch → background write-through tee →
// Content-Range synthesis → MIME override (same rebuild order as before the
// byte cache existed).
async function handleDriveStream(event, fileId, driveUrl, ext) {
  const cached = await serveFromByteCache(fileId, event.request, ext);
  if (cached) return cached;

  const response = await fetchDriveStream(event, driveUrl);
  const userResponse = writeThroughToCache(event, fileId, event.request, response);
  // Rebuild order matters: synthesize Content-Range FIRST (headers may
  // need it), then let overrideContentType fix the MIME on top.
  const rangeAware = ensureContentRange(fileId, userResponse, event.request);
  return overrideContentType(rangeAware, ext);
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
    event.respondWith(handleDriveStream(event, fileId, driveUrl, ext ?? ''));
  }
});
