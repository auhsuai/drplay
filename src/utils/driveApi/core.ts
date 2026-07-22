import { fetchWithAuth } from '../apiClient';

// Google Drive API resilience layer.
// Official guidance (developers.google.com/workspace/drive/api/guides/limits):
// 403/429 rate-limit and 5xx transient errors must be retried with exponential
// backoff + jitter; honor the Retry-After header when present. 4xx (400/401/404)
// are NOT retried here — 401 refresh is handled inside fetchWithAuth.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 4;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 32000;
const DEFAULT_TIMEOUT_MS = 20000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Derive a short, safe classification tag from an error's message ONLY.
// We never log the error object or its stack — those can leak file ids, user
// data, or (in theory) auth material into logs. Callers use this for observability.
export function classifyDriveError(err: unknown): string {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "unknown-error";
  const m = msg.toLowerCase();
  if (m.includes("timeout") || m.includes("aborterror")) return "timeout";
  if (m.includes("network") || m.includes("failed to fetch") || m.includes("unreachable"))
    return "network";
  const statusMatch = m.match(/\((\d{3})\)/);
  if (statusMatch) return `http-${statusMatch[1]}`;
  return "unknown";
}

export function backoffDelay(attempt: number, retryAfter?: string | null): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) {
      return Math.min(secs * 1000, MAX_DELAY_MS);
    }
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) {
      const diff = dateMs - Date.now();
      if (diff > 0) return Math.min(diff, MAX_DELAY_MS);
    }
  }
  const exp = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  const jitter = Math.random() * exp * 0.5;
  return Math.min(exp + jitter, MAX_DELAY_MS);
}

export async function driveFetch(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Fresh timeout signal per attempt (an aborted signal cannot be reused);
      // a caller-supplied signal takes precedence and is preserved across retries.
      const signal = options.signal ?? AbortSignal.timeout(timeoutMs);
      const res = await fetchWithAuth(url, { ...options, signal });

      if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES) {
        await sleep(backoffDelay(attempt, res.headers.get('Retry-After')));
        continue;
      }
      return res;
    } catch (err) {
      // Network failure or timeout (AbortError) — transient, retry with backoff.
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        await sleep(backoffDelay(attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Drive request failed after retries');
}
