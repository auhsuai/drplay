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

    const driveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;

    // Thực thi fetch trực tiếp lên Google Drive và trả về cho thẻ audio
    event.respondWith(fetchDriveStream(event, driveUrl));
  }
});
