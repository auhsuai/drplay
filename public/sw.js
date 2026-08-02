// DrPlay Service Worker
// Intercepts /drive-stream/{fileId} and proxies to Google Drive API with Authorization header
// NOTE: '/drive-stream/' prefix must match src/utils/streamPrefetcher.ts DRIVE_STREAM_PREFIX

let accessToken = '';

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
  }
});

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

    // Giữ nguyên các header gốc (đặc biệt là header Range: bytes=...)
    const newHeaders = new Headers(event.request.headers);
    
    // Bơm Token vào
    newHeaders.set('Authorization', `Bearer ${accessToken}`);

    const init = {
      method: event.request.method,
      headers: newHeaders,
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store'
    };

    const newRequest = new Request(driveUrl, init);

    // Thực thi fetch trực tiếp lên Google Drive và trả về cho thẻ audio
    event.respondWith(fetch(newRequest));
  }
});
