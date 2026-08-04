import { invoke } from "@tauri-apps/api/core";

import { captureError } from "./errorLog";
import { getCurrentSessionId } from "./sessionGuard";
import {
  ACCESS_TOKEN_KEY,
  REFRESH_TOKEN_KEY,
  TOKEN_TIME_KEY,
} from "./storageKeys";

export class TokenRefreshError extends Error {
  readonly kind: "network" | "invalid_grant" | "timeout" | "unknown";
  constructor(
    message: string,
    kind: "network" | "invalid_grant" | "timeout" | "unknown",
  ) {
    super(message);
    this.name = "TokenRefreshError";
    this.kind = kind;
  }
}

type TokenData = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
} | null;

const MAX_SAFE_TIMEOUT = 2_147_483_647; // 32-bit signed int limit (~24.8 days); larger values overflow and fire immediately

// Every outbound network call must be bounded so a stalled server cannot hang
// the caller indefinitely (checklist: "no timeout on network calls").
const FETCH_TIMEOUT_MS = 15_000;

// Tauri v2 invoke does not accept an AbortSignal (tauri issue #8351 is still
// open), so the refresh_google_token call must be bounded by a timeout
// wrapper — a stalled Rust backend could otherwise hang getValidToken forever.
const REFRESH_TIMEOUT_MS = 15_000;

// Keyring (OS credential vault) invokes can stall under lock-screen or DPAPI
// pressure; bound each one so a hung vault cannot block the refresh flow
// longer than this. Shorter than REFRESH_TIMEOUT_MS because a vault hiccup is
// transient and readRefreshToken has a localStorage fallback anyway.
const KEYRING_TIMEOUT_MS = 5000;

const PROACTIVE_REFRESH_MARGIN_SEC = 300;
const PROACTIVE_REFRESH_MIN_MS = 5000;
// Single source of truth for the token stale threshold: getValidToken treats a
// token as expired TOKEN_EXPIRY_MS after its issue time (see isExpired below).
// Exporting it lets useAuth schedule the proactive refresh from the SAME
// threshold instead of the server-reported lifetime, keeping both expiry
// models aligned (see computeProactiveRefreshDelayMs).
export const TOKEN_EXPIRY_MS = 50 * 60 * 1000;
const TOKEN_TIME_MAX_FUTURE_MS = 86_400_000;
const RETRY_DELAY_MS = 30_000;
const DEFAULT_EXPIRES_IN_SEC = 3600;

// Classify a failed Request/fetch rejection. Per spec a timeout via
// AbortSignal.timeout() rejects with a DOMException named 'TimeoutError';
// older Chromium surfaced it as 'AbortError', so treat AbortError as a
// timeout too. Anything else (DNS, TLS, connection refused) is a real
// network failure. (Sources: MDN AbortSignal.timeout, authon.dev 2026.)
function classifyRequestError(err: unknown): "network" | "timeout" {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError")
      return "timeout";
  }
  return "network";
}

// Bound a promise that cannot be cancelled (Tauri invoke has no AbortSignal,
// see issue tauri-apps/tauri#8351). The timeout error message must contain
// "timeout" so callers classifying errors by string keep working. The
// original promise still gets .then/.catch attached immediately, so a late
// rejection after the timeout fired is never an unhandled rejection.
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Token refresh timeout (no response within ${String(ms)}ms)`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
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

// Pure computation for the proactive-refresh timer delay. The effective token
// lifetime is capped at TOKEN_EXPIRY_MS/1000 (the stale threshold getValidToken
// enforces), NOT the server-reported expires_in: without the cap a 3600s
// expires_in would put the timer at 3300s while getValidToken already treats
// the token as stale at 3000s — the timer could never win the race.
export const computeProactiveRefreshDelayMs = (
  expiresInSeconds: number,
): number => {
  const safeExpires = Number.isFinite(expiresInSeconds)
    ? expiresInSeconds
    : DEFAULT_EXPIRES_IN_SEC;
  const effectiveLifetimeSec = Math.min(safeExpires, TOKEN_EXPIRY_MS / 1000);
  return Math.min(
    Math.max(
      (effectiveLifetimeSec - PROACTIVE_REFRESH_MARGIN_SEC) * 1000,
      PROACTIVE_REFRESH_MIN_MS,
    ),
    MAX_SAFE_TIMEOUT,
  );
};

export const scheduleProactiveRefresh = (expiresInSeconds: number) => {
  stopProactiveRefresh();
  refreshTimerId = setTimeout(async () => {
    try {
      await getValidToken(true);
    } catch (e: unknown) {
      await captureError({
        level: "warn",
        source: "apiClient",
        message: `Proactive refresh failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }, computeProactiveRefreshDelayMs(expiresInSeconds));
};

export async function revokeGoogleToken(token: string): Promise<void> {
  if (!token) return;
  try {
    await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `token=${encodeURIComponent(token)}`,
      signal: AbortSignal.timeout(5000),
    });
  } catch (err: unknown) {
    await captureError({
      level: "warn",
      source: "apiClient",
      message: `refresh-token-keyring-read-failed, falling back to localStorage: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

function getStoredTokenTime(): number {
  const raw = localStorage.getItem(TOKEN_TIME_KEY);
  const parsed = parseInt(raw || "", 10);

  if (
    !Number.isFinite(parsed) ||
    parsed <= 0 ||
    parsed > Date.now() + TOKEN_TIME_MAX_FUTURE_MS
  ) {
    // fire-and-forget: logging must not throw in this sync path (captureError
    // never rejects — it swallows failures internally).
    void captureError({
      level: "warn",
      source: "apiClient",
      message: "Invalid token_time detected, forcing refresh",
    });
    return 0;
  }

  return parsed;
}

function scheduleRetryRefresh() {
  if (refreshTimerId) clearTimeout(refreshTimerId);
  refreshTimerId = setTimeout(() => {
    getValidToken(true).catch(() =>
      captureError({
        level: "warn",
        source: "apiClient",
        message: "retry-refresh-failed",
      }),
    );
  }, RETRY_DELAY_MS);
}

// Read the long-lived refresh token from the OS credential vault (keyring).
// The keyring is the source of truth; localStorage only holds a legacy copy
// from before the keyring migration. Fallback order: keyring → localStorage →
// null. A keyring failure is non-fatal (warn + fallback), so a vault hiccup
// can never sign the user out.
export const readRefreshToken = async (): Promise<string | null> => {
  try {
    const keyringToken = await withTimeout(
      invoke<string | null>("get_refresh_token"),
      KEYRING_TIMEOUT_MS,
    );
    if (typeof keyringToken === "string" && keyringToken.length > 0) {
      return keyringToken;
    }
  } catch (err: unknown) {
    // Never log the token; the Rust side already strips it from its errors
    // (see token_store.rs).
    await captureError({
      level: "warn",
      source: "apiClient",
      message: `refresh-token-keyring-read-failed, falling back to localStorage: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  // Migration path: users who logged in before the keyring existed still have
  // their token here; the next successful write migrates it to the keyring
  // and removes this copy (see writeRefreshToken).
  return localStorage.getItem(REFRESH_TOKEN_KEY);
};

// Persist the long-lived refresh token in the OS credential vault. Fire-and-
// forget from the caller's perspective: it must not block the refresh flow
// (the access token is already valid). On failure the token is kept in
// localStorage (degraded mode, always logged) so it is never lost silently —
// the next rotation retries the keyring write. Never rejects.
export const writeRefreshToken = async (token: string): Promise<void> => {
  try {
    await withTimeout(
      invoke("set_refresh_token", { token }),
      KEYRING_TIMEOUT_MS,
    );
    // Success: the keyring is now the single source of truth — drop the
    // legacy localStorage copy so the credential never exists in two places.
    localStorage.removeItem(REFRESH_TOKEN_KEY);
  } catch (err: unknown) {
    await captureError({
      level: "warn",
      source: "apiClient",
      message: `refresh-token-keyring-write-failed, keeping localStorage fallback: ${err instanceof Error ? err.message : String(err)}`,
    });
    try {
      localStorage.setItem(REFRESH_TOKEN_KEY, token);
    } catch (storageErr: unknown) {
      // localStorage unavailable (quota/private mode): nothing left to do —
      // log, never throw (the caller is fire-and-forget and the access token
      // is still usable for its ~1h lifetime).
      await captureError({
        level: "warn",
        source: "apiClient",
        message: `refresh-token-localstorage-write-failed: ${storageErr instanceof Error ? storageErr.message : String(storageErr)}`,
      });
    }
  }
};

// Remove the long-lived refresh token from the OS credential vault. Called by
// logout so a signed-out shared machine cannot leave the credential behind in
// the keyring. Fire-and-forget and never rejects: the localStorage copy is
// always cleared too, so the token cannot survive in either store silently
// after a logout intent.
export const deleteRefreshToken = async (): Promise<void> => {
  try {
    await withTimeout(invoke("delete_refresh_token"), KEYRING_TIMEOUT_MS);
  } catch (err: unknown) {
    // Never log the token; the Rust side strips it from its errors (see
    // token_store.rs). A vault failure must not block logout — the access
    // token is already gone, so the session ends regardless.
    await captureError({
      level: "warn",
      source: "apiClient",
      message: `refresh-token-keyring-delete-failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  try {
    localStorage.removeItem(REFRESH_TOKEN_KEY);
  } catch {
    // localStorage unavailable (privacy mode / quota): the keyring delete
    // already ran; there is no second store to clear. Never throw — the
    // caller is fire-and-forget.
    await captureError({
      level: "warn",
      source: "apiClient",
      message: "refresh-token-localstorage-clear-failed",
    });
  }
};

export const getValidToken = async (
  forceRefresh: boolean = false,
  signal?: AbortSignal,
): Promise<string | null> => {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const token = localStorage.getItem(ACCESS_TOKEN_KEY);
  const issueTime = getStoredTokenTime();
  const isExpired = Date.now() - issueTime > TOKEN_EXPIRY_MS;

  if (isExpired || !token || forceRefresh) {
    const refreshToken = await readRefreshToken();
    if (!refreshToken) {
      window.dispatchEvent(new CustomEvent("auth-logout"));
      return null;
    }

    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    if (isRefreshing) {
      return new Promise((resolve, reject) => {
        refreshSubscribers.push({ resolve, reject });
      });
    }

    isRefreshing = true;
    const mySessionId = getCurrentSessionId();

    try {
      let tokenData: TokenData;
      try {
        tokenData = await withTimeout(
          invoke<TokenData>("refresh_google_token", { refreshToken }),
          REFRESH_TIMEOUT_MS,
        );
      } catch (err: unknown) {
        const errStr = String(err);
        if (
          errStr.includes("Failed to fetch") ||
          errStr.includes("timeout") ||
          errStr.includes("unreachable")
        ) {
          throw new TokenRefreshError("Network unreachable", "network");
        } else if (errStr.includes("invalid_grant")) {
          throw new TokenRefreshError(
            "Refresh token revoked/expired",
            "invalid_grant",
          );
        } else {
          throw new TokenRefreshError(`Unexpected error: ${errStr}`, "unknown");
        }
      }

      if (
        !tokenData ||
        typeof tokenData.access_token !== "string" ||
        tokenData.access_token.length === 0
      ) {
        throw new TokenRefreshError(
          "Malformed refresh response: missing access_token",
          "unknown",
        );
      }
      const accessToken = tokenData.access_token;

      if (mySessionId !== getCurrentSessionId()) {
        refreshSubscribers.forEach((sub) => {
          sub.resolve("");
        });
        return "";
      }

      localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
      localStorage.setItem(TOKEN_TIME_KEY, Date.now().toString());
      if (tokenData.refresh_token) {
        // Fire-and-forget: the access token is already valid, so persisting
        // the rotated refresh token must not delay the refresh flow.
        // writeRefreshToken never rejects (keyring failure → localStorage
        // fallback with a logged warning), so the credential is never lost
        // and the next read still finds it.
        void writeRefreshToken(tokenData.refresh_token);
      }

      scheduleProactiveRefresh(tokenData.expires_in || DEFAULT_EXPIRES_IN_SEC);
      window.dispatchEvent(
        new CustomEvent("token-updated", { detail: { token: accessToken } }),
      );

      refreshSubscribers.forEach((sub) => {
        sub.resolve(accessToken);
      });
      return accessToken;
    } catch (err: unknown) {
      refreshSubscribers.forEach((sub) => {
        sub.reject(err instanceof Error ? err : new Error(String(err)));
      });

      if (err instanceof TokenRefreshError) {
        if (err.kind === "invalid_grant") {
          window.dispatchEvent(new CustomEvent("auth-logout"));
        } else {
          await captureError({
            level: "warn",
            source: "apiClient",
            message: `Token refresh failed (${err.kind}), will retry`,
          });
          scheduleRetryRefresh();
        }
      } else {
        window.dispatchEvent(new CustomEvent("auth-logout"));
      }
      return null;
    } finally {
      isRefreshing = false;
      refreshSubscribers = [];
    }
  }

  return token;
};

export interface FetchWithAuthOptions extends RequestInit {
  // Caller-overridable request timeout (ms) for long-running operations such
  // as large upload PUT bodies that legitimately outlast the 15s default.
  timeoutMs?: number;
}

export const fetchWithAuth = async (
  url: RequestInfo,
  options: FetchWithAuthOptions = {},
): Promise<Response> => {
  const { timeoutMs, ...fetchOptions } = options;
  const token = localStorage.getItem(ACCESS_TOKEN_KEY);

  // Ensure headers exist and attach token
  const headers = new Headers(options.headers);
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  // An explicit override wins only when it is a finite positive number; 0,
  // negative, NaN or absent values fall back to the default. Capped at
  // MAX_SAFE_TIMEOUT so an absurd value cannot overflow setTimeout and fire
  // immediately (see the MAX_SAFE_TIMEOUT note above).
  const effectiveTimeoutMs =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.min(timeoutMs, MAX_SAFE_TIMEOUT)
      : FETCH_TIMEOUT_MS;

  // Every outbound fetch must be bounded by a timeout so a stalled server
  // cannot hang the caller forever. Merge with any caller-supplied signal
  // (e.g. a component-unmount cancel) via AbortSignal.any so neither wins,
  // falling back to the timeout alone on runtimes lacking AbortSignal.any.
  const timeoutSignal = AbortSignal.timeout(effectiveTimeoutMs);
  const signal =
    options.signal && typeof AbortSignal.any === "function"
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;

  const requestOptions: RequestInit = { ...fetchOptions, headers, signal };

  // Main request (timeout-bounded). Network/timeout here reject naturally so
  // callers can decide retry vs. surface; we never swallow a hang.
  const response = await fetch(url, requestOptions);

  // Nếu gặp lỗi 401 Unauthorized
  if (response.status === 401) {
    const newToken = await getValidToken(true);
    if (newToken) {
      const retryHeaders = new Headers(options.headers);
      retryHeaders.set("Authorization", `Bearer ${newToken}`);
      try {
        // Retry also uses the same bounded signal so it cannot hang either.
        return await fetch(url, {
          ...fetchOptions,
          headers: retryHeaders,
          signal,
        });
      } catch (err: unknown) {
        // Retry failed: classify and throw a clear, typed error. We do NOT
        // swallow it (caller must know) and we do NOT hang.
        const kind = classifyRequestError(err);
        throw new TokenRefreshError(`Retry after 401 failed (${kind})`, kind);
      }
    }
  }

  return response;
};
