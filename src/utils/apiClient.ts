import { invoke } from "@tauri-apps/api/core";

import { getCurrentSessionId } from "./sessionGuard";

export class TokenRefreshError extends Error {
  constructor(
    message: string,
    public readonly kind: 'network' | 'invalid_grant' | 'timeout' | 'unknown'
  ) {
    super(message);
    this.name = 'TokenRefreshError';
  }
}

const CLIENT_MODULE = "Auth";

interface RefreshTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

const MAX_SAFE_TIMEOUT = 2_147_483_647; // 32-bit signed int limit (~24.8 days); larger values overflow and fire immediately

// Every outbound network call must be bounded so a stalled server cannot hang
// the caller indefinitely (checklist: "no timeout on network calls").
const FETCH_TIMEOUT_MS = 15_000;

// Classify a failed Request/fetch rejection. Per spec a timeout via
// AbortSignal.timeout() rejects with a DOMException named 'TimeoutError';
// older Chromium surfaced it as 'AbortError', so treat AbortError as a
// timeout too. Anything else (DNS, TLS, connection refused) is a real
// network failure. (Sources: MDN AbortSignal.timeout, authon.dev 2026.)
function classifyRequestError(err: unknown): 'network' | 'timeout' {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timeout';
  }
  return 'network';
}

// Classify a Tauri invoke() rejection for observability (no secrets logged).
function classifyInvokeError(err: unknown): 'network' | 'timeout' | 'unknown' {
  const errStr = err instanceof Error ? err.message : String(err);
  if (/timeout/i.test(errStr)) return 'timeout';
  if (/failed to fetch|unreachable|network/i.test(errStr)) return 'network';
  return 'unknown';
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
  const safeExpires = Number.isFinite(expiresInSeconds) ? expiresInSeconds : 3600;
  // Refresh 5 min before expiry so the timer always fires before getValidToken's
  // 50-min "isExpired" threshold treats the token as stale on a play attempt.
  const refreshInMs = Math.min(
    Math.max((safeExpires - 300) * 1000, 5000),
    MAX_SAFE_TIMEOUT
  );
  refreshTimerId = setTimeout(async () => {
    try {
      await getValidToken(true);
    } catch (e) {
      console.warn("[Auth] Proactive refresh failed", e);
    }
  }, refreshInMs);
};

export async function revokeGoogleToken(token: string): Promise<void> {
  if (!token) return;
  try {
    await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(token)}`,
      signal: AbortSignal.timeout(5000),
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
  if (refreshTimerId) clearTimeout(refreshTimerId);
  const RETRY_DELAY = 30_000;
  refreshTimerId = setTimeout(() => {
    getValidToken(true).catch(e => console.warn(`[${CLIENT_MODULE}] retry-refresh-failed`, classifyRequestError(e)));
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
      let tokenData: RefreshTokenResponse;
      try {
        tokenData = await invoke<RefreshTokenResponse>("refresh_google_token", { refreshToken });
      } catch (err: unknown) {
        const errStr = String(err);
        if (errStr.includes("Failed to fetch") || errStr.includes("timeout") || errStr.includes("unreachable")) {
          throw new TokenRefreshError('Network unreachable', 'network');
        } else if (errStr.includes("invalid_grant")) {
          throw new TokenRefreshError('Refresh token revoked/expired', 'invalid_grant');
        } else {
          throw new TokenRefreshError(`Unexpected error: ${errStr}`, 'unknown');
        }
      }

      if (!tokenData || typeof tokenData.access_token !== 'string' || tokenData.access_token.length === 0) {
        throw new TokenRefreshError('Malformed refresh response: missing access_token', 'unknown');
      }

      if (mySessionId !== getCurrentSessionId()) {
        refreshSubscribers.forEach(sub => sub.resolve(''));
        return '';
      }
      
      localStorage.setItem("drplay_access_token", tokenData.access_token);
      localStorage.setItem("drplay_token_time", Date.now().toString());
      if (tokenData.refresh_token) {
        localStorage.setItem("drplay_refresh_token", tokenData.refresh_token);
      }

      // Await so the Rust proxy has the fresh token BEFORE we resolve waiters /
      // trigger any reload. Otherwise the next stream request can race an
      // un-updated proxy token and 401. Also wakes proxy waiters via notify.
      try {
        await invoke("update_stream_token", { token: tokenData.access_token });
      } catch (e) {
        // Best-effort: the fresh token is already persisted to localStorage, so a
        // proxy update failure must NOT block playback or reject waiters. Classify
        // for observability and continue.
        const kind = classifyInvokeError(e);
        console.warn("[Auth] Stream proxy token update failed (best-effort, continuing)", kind);
      }

      scheduleProactiveRefresh(tokenData.expires_in || 3600);
      window.dispatchEvent(new CustomEvent('token-updated', { detail: { token: tokenData.access_token } }));
      
      refreshSubscribers.forEach(sub => sub.resolve(tokenData.access_token));
      return tokenData.access_token;
    } catch (err: unknown) {
      refreshSubscribers.forEach(sub => sub.reject(err instanceof Error ? err : new Error(String(err))));
      
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

  // Every outbound fetch must be bounded by a timeout so a stalled server
  // cannot hang the caller forever. Merge with any caller-supplied signal
  // (e.g. a component-unmount cancel) via AbortSignal.any so neither wins,
  // falling back to the timeout alone on runtimes lacking AbortSignal.any.
  const createRequestSignal = (): AbortSignal => {
    const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    return options.signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
  };

  // Main request (timeout-bounded). Network/timeout here reject naturally so
  // callers can decide retry vs. surface; we never swallow a hang.
  const response = await fetch(url, {
    ...options,
    headers,
    signal: createRequestSignal(),
  });

  // Nếu gặp lỗi 401 Unauthorized
  if (response.status === 401) {
    const newToken = await getValidToken(true);
    if (newToken) {
      const retryHeaders = new Headers(options.headers);
      retryHeaders.set("Authorization", `Bearer ${newToken}`);
      try {
        // AbortSignal is single-use. A fresh timeout signal prevents a slow
        // first 401 response from consuming the retry's entire timeout budget.
        return await fetch(url, {
          ...options,
          headers: retryHeaders,
          signal: createRequestSignal(),
        });
      } catch (err) {
        // Retry failed: classify and throw a clear, typed error. We do NOT
        // swallow it (caller must know) and we do NOT hang.
        const kind = classifyRequestError(err);
        throw new TokenRefreshError(`Retry after 401 failed (${kind})`, kind);
      }
    }
  }

  return response;
};
