import { invoke } from "@tauri-apps/api/core";

import { getCurrentSessionId } from "./sessionGuard";

export class TokenRefreshError extends Error {
  constructor(
    message: string,
    public readonly kind: 'network' | 'invalid_grant' | 'unknown'
  ) {
    super(message);
    this.name = 'TokenRefreshError';
  }
}

let isRefreshing = false;
let refreshSubscribers: Array<{
  resolve: (token: string) => void;
  reject: (err: Error) => void;
}> = [];
let refreshTimerId: ReturnType<typeof setTimeout> | null = null;

export const stopProactiveRefresh = () => {
  if (refreshTimerId) {
    clearTimeout(refreshTimerId);
    refreshTimerId = null;
  }
};

export const scheduleProactiveRefresh = (expiresInSeconds: number) => {
  stopProactiveRefresh();
  const refreshInMs = Math.max((expiresInSeconds - 180) * 1000, 5000);
  refreshTimerId = setTimeout(async () => {
    await getValidToken(true);
  }, refreshInMs);
};

export async function revokeGoogleToken(token: string): Promise<void> {
  try {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  } catch (err) {
    console.warn('[Auth] Revoke token failed (non-blocking)', err);
  }
}

function getStoredTokenTime(): number {
  const raw = localStorage.getItem('drplay_token_time');
  const parsed = parseInt(raw || '', 10);
  
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > Date.now() + 86_400_000) {
    console.warn('[Auth] Invalid token_time detected, forcing refresh');
    return 0;
  }
  
  return parsed;
}

function scheduleRetryRefresh() {
  const RETRY_DELAY = 30_000;
  setTimeout(() => {
    getValidToken(true).catch(e => console.warn("Retry refresh failed", e));
  }, RETRY_DELAY);
}

export const getValidToken = async (forceRefresh: boolean = false): Promise<string | null> => {
  const token = localStorage.getItem("drplay_access_token");
  const issueTime = getStoredTokenTime();
  const isExpired = Date.now() - issueTime > 50 * 60 * 1000;

  if (isExpired || !token || forceRefresh) {
    const refreshToken = localStorage.getItem("drplay_refresh_token");
    if (!refreshToken) {
      window.dispatchEvent(new CustomEvent('auth-logout'));
      return null;
    }

    if (isRefreshing) {
      return new Promise((resolve, reject) => {
        refreshSubscribers.push({ resolve, reject });
      });
    }

    isRefreshing = true;
    const mySessionId = getCurrentSessionId();

    try {
      let tokenData;
      try {
        tokenData = await invoke<any>("refresh_google_token", { refreshToken });
      } catch (err: any) {
        const errStr = String(err);
        if (errStr.includes("Failed to fetch") || errStr.includes("timeout") || errStr.includes("unreachable")) {
          throw new TokenRefreshError('Network unreachable', 'network');
        } else if (errStr.includes("invalid_grant")) {
          throw new TokenRefreshError('Refresh token revoked/expired', 'invalid_grant');
        } else {
          throw new TokenRefreshError(`Unexpected error: ${errStr}`, 'unknown');
        }
      }

      if (mySessionId !== getCurrentSessionId()) {
        console.debug('[Auth] Refresh result discarded - session changed');
        refreshSubscribers.forEach(sub => sub.resolve(''));
        return '';
      }
      
      localStorage.setItem("drplay_access_token", tokenData.access_token);
      localStorage.setItem("drplay_token_time", Date.now().toString());
      if (tokenData.refresh_token) {
        localStorage.setItem("drplay_refresh_token", tokenData.refresh_token);
      }

      invoke("update_stream_token", { token: tokenData.access_token }).catch(e => console.error("Rust stream token update fail", e));

      scheduleProactiveRefresh(tokenData.expires_in || 3600);
      window.dispatchEvent(new CustomEvent('token-updated', { detail: { token: tokenData.access_token } }));
      
      refreshSubscribers.forEach(sub => sub.resolve(tokenData.access_token));
      return tokenData.access_token;
    } catch (err: any) {
      refreshSubscribers.forEach(sub => sub.reject(err));
      
      if (err instanceof TokenRefreshError) {
        if (err.kind === 'invalid_grant') {
          window.dispatchEvent(new CustomEvent('auth-logout'));
        } else {
          console.warn('[Auth] Refresh tạm thời thất bại, sẽ thử lại', err.kind);
          scheduleRetryRefresh();
        }
      } else {
         window.dispatchEvent(new CustomEvent('auth-logout'));
      }
      return null;
    } finally {
      isRefreshing = false;
      refreshSubscribers = [];
    }
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
