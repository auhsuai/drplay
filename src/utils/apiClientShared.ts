import { captureError } from "./errorLog";

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

// Log a warning attributed to the apiClient suite. Every call site used to
// repeat the captureError boilerplate; the level/source pair is invariant.
export const warn = (message: string): Promise<void> =>
  captureError({ level: "warn", source: "apiClient", message });

// Compact rendering for a caught unknown: Error → message, anything else →
// String(). Never include the token or other secrets at call sites.
export const errMsg = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

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

// Let ONE caller escape an await as soon as its signal fires, WITHOUT
// touching the awaited promise itself — the shared single-flight refresh must
// keep running for every other caller (abort is per-caller, never a cancel of
// the shared work). An already-aborted signal rejects immediately; the abort
// listener is always removed once the race settles, so no listener leaks.
export function raceWithAbortSignal<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (err: unknown) => {
        cleanup();
        // Same normalization as withTimeout above: the shared flight always
        // rejects with Error instances, but never propagate a non-Error raw.
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
