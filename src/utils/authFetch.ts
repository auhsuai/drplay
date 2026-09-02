import { ACCESS_TOKEN_KEY } from "./storageKeys";
import {
  TokenRefreshError,
  MAX_SAFE_TIMEOUT,
  FETCH_TIMEOUT_MS,
  classifyRequestError,
} from "./apiClientShared";
import { getValidToken } from "./tokenRefresh";

export interface FetchWithAuthOptions extends RequestInit {
  // Caller-overridable request timeout (ms) for long-running operations such
  // as large upload PUT bodies that legitimately outlast the 15s default.
  timeoutMs?: number;
}

/**
 * Fetch with the current access token attached. Every call is bounded by a
 * timeout (default 15s, overridable via `timeoutMs`) so a stalled server can
 * never hang the caller; a caller signal and the timeout are merged, neither
 * wins. On a 401 the token is force-refreshed once and the request retried
 * with the new token; when the refresh cannot produce a token the original
 * 401 response is returned. Network/timeout failures reject (the caller
 * decides retry vs. surface) — nothing is swallowed.
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
