import { ACCESS_TOKEN_KEY, safeLocalStorageGet } from "./storageKeys";
import {
  TokenRefreshError,
  raceWithAbortSignal,
  MAX_SAFE_TIMEOUT,
} from "./apiClientShared";
import { getValidToken } from "./tokenRefresh";

// Every outbound network call must be bounded so a stalled server cannot hang
// the caller indefinitely (checklist: "no timeout on network calls").
const FETCH_TIMEOUT_MS = 15_000;

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

export interface FetchWithAuthOptions extends RequestInit {
  // Caller-overridable request timeout (ms) for long-running operations such
  // as large upload PUT bodies that legitimately outlast the 15s default.
  timeoutMs?: number;
}

// Merge the caller's signal (e.g. a component-unmount cancel) with a fresh
// per-attempt timeout signal via AbortSignal.any so neither wins, falling back
// to the timeout alone on runtimes lacking AbortSignal.any.
const mergeCallerSignal = (
  callerSignal: AbortSignal | null | undefined,
  timeoutMs: number,
): AbortSignal => {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return callerSignal && typeof AbortSignal.any === "function"
    ? AbortSignal.any([callerSignal, timeoutSignal])
    : timeoutSignal;
};

/**
 * Fetch with the current access token attached. Every call is bounded by a
 * timeout (default 15s, overridable via `timeoutMs`) so a stalled server can
 * never hang the caller; a caller signal and the timeout are merged, neither
 * wins. On a 401 the token is force-refreshed once and the request retried
 * with the new token; when the refresh cannot produce a token the original
 * 401 response is returned. A caller cancel while waiting for that refresh
 * rejects THIS call immediately with an AbortError (the shared single-flight
 * refresh keeps running for other callers). Network/timeout failures reject
 * (the caller decides retry vs. surface) — nothing is swallowed.
 * @param url The request target (Drive API or any authed endpoint).
 * @param options Fetch options, plus an optional `timeoutMs` override for
 * long-running bodies (e.g. large upload PUTs) that outlast the 15s default.
 * @returns The final Response (original or 401-retried); callers inspect
 * `.ok`/`.status` themselves.
 */
export const fetchWithAuth = async (
  url: RequestInfo,
  options: FetchWithAuthOptions = {},
): Promise<Response> => {
  const { timeoutMs, ...fetchOptions } = options;

  // Storage-failure safe: an unreadable token (privacy mode / quota) degrades
  // to null → the request goes out without an Authorization header instead of
  // crashing before the request is even sent.
  const token = safeLocalStorageGet(
    ACCESS_TOKEN_KEY,
    "access-token-read",
    "apiClient",
  );

  // Ensure headers exist and attach token
  const headers = new Headers(options.headers);
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  // An explicit override wins only when it is a finite positive number; 0,
  // negative, NaN or absent values fall back to the default. Capped at
  // MAX_SAFE_TIMEOUT so an absurd value cannot overflow setTimeout and fire
  // immediately (see the MAX_SAFE_TIMEOUT note in apiClientShared).
  const effectiveTimeoutMs =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.min(timeoutMs, MAX_SAFE_TIMEOUT)
      : FETCH_TIMEOUT_MS;

  const requestOptions: RequestInit = {
    ...fetchOptions,
    headers,
    signal: mergeCallerSignal(options.signal, effectiveTimeoutMs),
  };

  // Main request (timeout-bounded). Network/timeout here reject naturally so
  // callers can decide retry vs. surface; we never swallow a hang.
  const response = await fetch(url, requestOptions);

  // Nếu gặp lỗi 401 Unauthorized
  if (response.status === 401) {
    let newToken: string | null;
    try {
      // The caller signal is forwarded so a cancel during the refresh wait
      // escapes immediately: getValidToken races the signal at its entry
      // checks and at the follower join, and the outer race here covers the
      // lead-wait too. Either way only THIS request aborts (AbortError) —
      // the shared single-flight refresh continues for every other caller.
      // RequestInit.signal is nullable; normalize to undefined so both the
      // parameter and the race helper see one consistent type.
      const callerSignal = options.signal ?? undefined;
      newToken = await raceWithAbortSignal(
        getValidToken(true, callerSignal),
        callerSignal,
      );
    } catch (err: unknown) {
      // This call was a FOLLOWER of an in-flight refresh whose shared
      // promise rejected: getValidToken's lead caller already ran the error
      // side-effects exactly once (auth-logout for invalid_grant / retry
      // scheduling otherwise), so mirror its null-return outcome and return
      // the original 401 response per the JSDoc above. Any non-
      // TokenRefreshError failure keeps the reject contract.
      if (!(err instanceof TokenRefreshError)) throw err;
      return response;
    }
    if (newToken) {
      const retryHeaders = new Headers(options.headers);
      retryHeaders.set("Authorization", `Bearer ${newToken}`);
      try {
        // The retry gets a FRESH per-attempt deadline: the original merged
        // signal has already spent most of its budget on the first attempt's
        // wire time plus the refresh round-trip, so reusing it would abort a
        // healthy retry almost immediately with TimeoutError. Each attempt
        // owns its own full effectiveTimeoutMs (same philosophy as the
        // main request above); the caller signal stays in the merge so a
        // caller cancel still cancels the retry instantly.
        return await fetch(url, {
          ...fetchOptions,
          headers: retryHeaders,
          signal: mergeCallerSignal(options.signal, effectiveTimeoutMs),
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
