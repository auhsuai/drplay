import { invoke } from "@tauri-apps/api/core";

// Biến lock để tránh gọi refresh token nhiều lần cùng lúc khi có nhiều request thất bại
let isRefreshing = false;
let refreshSubscribers: ((token: string) => void)[] = [];

const subscribeTokenRefresh = (cb: (token: string) => void) => {
  refreshSubscribers.push(cb);
};

const onRefreshed = (token: string) => {
  refreshSubscribers.forEach((cb) => cb(token));
  refreshSubscribers = [];
};

/**
 * Lấy token hiện tại, nếu sắp hết hạn (còn < 10 phút) thì chủ động refresh.
 * Dùng cho các tác vụ không dùng fetch (như gọi xuống Rust qua Tauri).
 */
export const getValidToken = async (forceRefresh: boolean = false): Promise<string | null> => {
  const token = localStorage.getItem("drplay_access_token");
  const issueTime = parseInt(localStorage.getItem("drplay_token_time") || "0");
  // Nếu đã quá 50 phút kể từ lúc cấp (token thường sống 60p)
  const isExpired = Date.now() - issueTime > 50 * 60 * 1000;

  if (isExpired || !token || forceRefresh) {
    const refreshToken = localStorage.getItem("drplay_refresh_token");
    if (!refreshToken) {
      window.dispatchEvent(new CustomEvent('auth-logout'));
      return null;
    }

    if (!isRefreshing) {
      isRefreshing = true;
      try {
        const tokenData = await invoke<any>("refresh_google_token", { refreshToken });
        
        localStorage.setItem("drplay_access_token", tokenData.access_token);
        localStorage.setItem("drplay_token_time", Date.now().toString());
        if (tokenData.refresh_token) {
          localStorage.setItem("drplay_refresh_token", tokenData.refresh_token);
        }

        invoke("update_stream_token", { token: tokenData.access_token }).catch(e => console.error("Rust stream token update fail", e));

        isRefreshing = false;
        onRefreshed(tokenData.access_token);
        window.dispatchEvent(new CustomEvent('token-updated', { detail: { token: tokenData.access_token } }));
        return tokenData.access_token;
      } catch (err) {
        isRefreshing = false;
        refreshSubscribers = [];
        console.error("Failed to proactive refresh token", err);
        window.dispatchEvent(new CustomEvent('auth-logout'));
        return null;
      }
    }

    // Nếu đang refresh, đợi token mới
    return new Promise((resolve) => {
      subscribeTokenRefresh((newToken: string) => {
        resolve(newToken);
      });
    });
  }

  return token;
};

export const fetchWithAuth = async (url: RequestInfo, options: RequestInit = {}): Promise<Response> => {
  let token = localStorage.getItem("drplay_access_token");

  // Ensure headers exist and attach token
  const headers = new Headers(options.headers);
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const newOptions = { ...options, headers };

  let response = await fetch(url, newOptions);

  // Nếu gặp lỗi 401 Unauthorized
  if (response.status === 401) {
    const newToken = await getValidToken();
    if (newToken) {
      const retryHeaders = new Headers(options.headers);
      retryHeaders.set("Authorization", `Bearer ${newToken}`);
      return fetch(url, { ...options, headers: retryHeaders });
    }
  }

  return response;
};
