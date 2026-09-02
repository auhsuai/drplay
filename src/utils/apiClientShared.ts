// Shared low-level helpers for the auth/token modules: the typed refresh
// error, the bounded-timeout wrapper and the error classification. No
// module-level mutable state lives here — everything is pure or stateless.

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

export const MAX_SAFE_TIMEOUT = 2_147_483_647; // 32-bit signed int limit (~24.8 days); larger values overflow and fire immediately

// Every outbound network call must be bounded so a stalled server cannot hang
// the caller indefinitely (checklist: "no timeout on network calls").
export const FETCH_TIMEOUT_MS = 15_000;

// Classify a failed Request/fetch rejection. Per spec a timeout via
// AbortSignal.timeout() rejects with a DOMException named 'TimeoutError';
// older Chromium surfaced it as 'AbortError', so treat AbortError as a
// timeout too. Anything else (DNS, TLS, connection refused) is a real
// network failure. (Sources: MDN AbortSignal.timeout, authon.dev 2026.)
export function classifyRequestError(err: unknown): "network" | "timeout" {
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
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(`Token refresh timeout (no response within ${String(ms)}ms)`),
      );
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
