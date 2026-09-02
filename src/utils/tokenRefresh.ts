import { invoke } from "@tauri-apps/api/core";

import { captureError } from "./errorLog";
import { getCurrentSessionId } from "./sessionGuard";
import {
  ACCESS_TOKEN_KEY,
  TOKEN_TIME_KEY,
  safeLocalStorageGet,
  safeLocalStorageSet,
} from "./storageKeys";
import { backoffDelay } from "./retryDelay";
import {
  TokenRefreshError,
  raceWithAbortSignal,
  warn,
  withTimeout,
  MAX_SAFE_TIMEOUT,
} from "./apiClientShared";
import { readRefreshToken, writeRefreshToken } from "./refreshTokenStore";

// Tauri v2 invoke does not accept an AbortSignal (tauri issue #8351 is still
// open), so the refresh_google_token call must be bounded by a timeout
// wrapper — a stalled Rust backend could otherwise hang getValidToken forever.
const REFRESH_TIMEOUT_MS = 15_000;

const PROACTIVE_REFRESH_MARGIN_SEC = 300;
const PROACTIVE_REFRESH_MIN_MS = 5000;
// Single source of truth for the token staleness threshold: getValidToken treats
// a token as expired past this age, and the proactive-refresh scheduler models
// the same expiry (see computeProactiveRefreshDelayMs).
export const TOKEN_EXPIRY_MS = 50 * 60 * 1000;
const TOKEN_TIME_MAX_FUTURE_MS = 86_400_000;
// Retry-refresh backoff policy (AGENTS.md Luật 4: never retry forever). A
// transient refresh failure is retried at most RETRY_MAX_ATTEMPTS times with
// exponential backoff from RETRY_BASE_DELAY_MS, capped at RETRY_MAX_DELAY_MS;
// once the budget is exhausted the chain stops until a new refresh cycle.
const RETRY_BASE_DELAY_MS = 30_000;
const RETRY_MAX_DELAY_MS = 120_000;
const RETRY_MAX_ATTEMPTS = 4;
const DEFAULT_EXPIRES_IN_SEC = 3600;

type TokenData = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
} | null;

// Single-flight guard for concurrent token refresh: while a refresh is in
// flight, later getValidToken callers await the SAME promise instead of each
// firing their own. Nulled in a finally once the refresh settles, so
// the next refresh starts a fresh flight.
let refreshPromise: Promise<string | null> | null = null;
let refreshTimerId: ReturnType<typeof setTimeout> | null = null;
// Retries already scheduled in the current failed-refresh cycle. Reset on a
// successful refresh and whenever the chain is stopped (stopProactiveRefresh),
// so a later failure always starts a fresh cycle from the base delay.
let retryAttempt = 0;

export const stopProactiveRefresh = () => {
  if (refreshTimerId) {
    clearTimeout(refreshTimerId);
    refreshTimerId = null;
  }
  retryAttempt = 0;
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
  const handler = async () => {
    try {
      await getValidToken(true);
    } catch (e: unknown) {
      await captureError({
        level: "warn",
        source: "apiClient",
        message: `Proactive refresh failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  };
  refreshTimerId = setTimeout(() => {
    void handler();
  }, computeProactiveRefreshDelayMs(expiresInSeconds));
};

function getStoredTokenTime(): number {
  // Storage-failure safe: a read failure degrades to null → parsed as invalid
  // → forces a refresh (the correct degraded behavior), never throws.
  const raw = safeLocalStorageGet(
    TOKEN_TIME_KEY,
    "token-time-read",
    "apiClient",
  );
  const parsed = parseInt(raw || "", 10);

  if (
    !Number.isFinite(parsed) ||
    parsed <= 0 ||
    parsed > Date.now() + TOKEN_TIME_MAX_FUTURE_MS
  ) {
    // fire-and-forget: logging must not throw in this sync path (captureError
    // never rejects — it swallows failures internally).
    void warn("Invalid token_time detected, forcing refresh");
    return 0;
  }

  return parsed;
}

function scheduleRetryRefresh() {
  if (refreshTimerId) {
    clearTimeout(refreshTimerId);
    refreshTimerId = null;
  }
  if (retryAttempt >= RETRY_MAX_ATTEMPTS) {
    retryAttempt = 0;
    void warn(
      "Token refresh retry limit reached, giving up until a new refresh cycle",
    );
    return;
  }
  const delayMs = backoffDelay(retryAttempt, null, {
    baseMs: RETRY_BASE_DELAY_MS,
    maxMs: RETRY_MAX_DELAY_MS,
    // Single-client refresh (no thundering-herd risk), so keep the backoff
    // deterministic (jitter window 0) for predictable retry spacing.
    jitterMaxMs: 0,
  });
  retryAttempt += 1;
  refreshTimerId = setTimeout(() => {
    getValidToken(true).catch(() => warn("retry-refresh-failed"));
  }, delayMs);
}

/**
 * Return an access token that is guaranteed (as far as local bookkeeping
 * can tell) not to be stale, refreshing via the refresh token when needed.
 * This is the single entry point every authed request and the pro-sync worker
 * use, so refresh happens once and concurrent callers share the same in-flight
 * refresh instead of each firing their own. On refresh failure with a revoked
 * grant it dispatches 'auth-logout' so the session ends; transient failures
 * schedule a bounded retry. When no refresh token exists the user is treated
 * as signed out (dispatch 'auth-logout' + return null).
 * @param forceRefresh Skip the staleness check and refresh unconditionally
 * (used on 401 retries and proactive/worker refreshes).
 * @param signal Optional caller cancellation. Aborting rejects THIS caller
 * with an AbortError as soon as the signal fires (entry, mid-wait on a joined
 * flight) — the shared refresh itself is NEVER cancelled and keeps running
 * for other callers; only the aborting caller escapes early.
 * @returns The valid access token, or null when no token is available (signed
 * out / refresh impossible). An empty string means the session changed while
 * refreshing (logout raced the refresh).
 */
export const getValidToken = async (
  forceRefresh: boolean = false,
  signal?: AbortSignal,
): Promise<string | null> => {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  // Storage-failure safe: an unreadable token (privacy mode / quota) degrades
  // to null → the refresh path runs, instead of rejecting with a raw error.
  const token = safeLocalStorageGet(
    ACCESS_TOKEN_KEY,
    "access-token-read",
    "apiClient",
  );
  const issueTime = getStoredTokenTime();
  const isExpired = Date.now() - issueTime > TOKEN_EXPIRY_MS;

  if (isExpired || !token || forceRefresh) {
    const refreshToken = await readRefreshToken();
    if (!refreshToken) {
      window.dispatchEvent(new CustomEvent("auth-logout"));
      return null;
    }
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (refreshPromise) {
      // Another caller already has a refresh in flight: share the same
      // promise. Success delivers the same token (or "" when the session
      // changed) to everyone; failure rejects so every follower throws, while
      // the lead caller (the one that created the promise, below) converts
      // the failure into a null return. A caller signal only rescues THIS
      // caller from the wait (AbortError) — the shared flight keeps running
      // for everyone else (single-flight is never cancelled by one aborter).
      return raceWithAbortSignal(refreshPromise, signal);
    }

    refreshPromise = (async (): Promise<string | null> => {
      const mySessionId = getCurrentSessionId();

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
        return "";
      }

      // Persistence is best-effort: a storage failure here (quota / privacy
      // mode) is logged and ignored. It must NEVER reject this IIFE — a raw
      // rejection is not a TokenRefreshError, so the lead caller's catch
      // would dispatch 'auth-logout' and sign the user out over a transient
      // environment problem. The access token stays valid in memory and the
      // token-updated broadcast below still fires.
      safeLocalStorageSet(
        ACCESS_TOKEN_KEY,
        accessToken,
        "access-token-persist",
        "apiClient",
      );
      safeLocalStorageSet(
        TOKEN_TIME_KEY,
        Date.now().toString(),
        "token-time-persist",
        "apiClient",
      );
      if (tokenData.refresh_token) {
        // Fire-and-forget: the access token is already valid, so persisting
        // the rotated refresh token must not delay the refresh flow.
        // writeRefreshToken never rejects (keyring failure → in-memory
        // fallback with a logged warning), so the credential is never lost
        // silently and the next read still finds it this session.
        void writeRefreshToken(tokenData.refresh_token);
      }

      scheduleProactiveRefresh(tokenData.expires_in || DEFAULT_EXPIRES_IN_SEC);
      window.dispatchEvent(
        new CustomEvent("token-updated", { detail: { token: accessToken } }),
      );

      return accessToken;
    })();

    try {
      // Lead caller: awaits the shared promise. On failure the promise
      // rejected (which is what makes followers throw) — handle the
      // error side-effects exactly once here and return null.
      return await refreshPromise;
    } catch (err: unknown) {
      if (err instanceof TokenRefreshError) {
        if (err.kind === "invalid_grant") {
          window.dispatchEvent(new CustomEvent("auth-logout"));
        } else {
          await warn(`Token refresh failed (${err.kind}), will retry`);
          scheduleRetryRefresh();
        }
      } else {
        window.dispatchEvent(new CustomEvent("auth-logout"));
      }
      return null;
    } finally {
      refreshPromise = null;
    }
  }

  return token;
};
