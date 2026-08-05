import React from "react";
import ReactDOM from "react-dom/client";
import "./i18n";
import App from "./App";
import { initLogger } from "./utils/logger";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { captureError } from "./utils/errorLog";

initLogger();

// An AbortError is always thrown by an explicit controller.abort() or
// AbortSignal.timeout(). We must NOT swallow the timeout case (that is a real
// failure worth logging as kind='timeout'), only intentional user/code cancels
// (skip track, unmount, prefetch cancellation) which are benign noise.
function isIntentionalAbort(reason: unknown): boolean {
  if (!(reason instanceof Error)) return false;
  if (reason.name !== "AbortError") return false;
  // AbortSignal.timeout() reuses AbortError but its message mentions timeout —
  // treat that as a real timeout, NOT a benign cancel.
  if (/timeout/i.test(reason.message)) return false;
  return true;
}

// window.onerror's `error` property can be any throwable: an Error, a
// DOMException, or a plain carrier object like `{ stack: string }`. Read
// .stack safely, preserving the old `e.error?.stack` passthrough for string
// stacks (non-string stacks are dropped instead of forwarded).
function errorStack(err: unknown): string | undefined {
  if (err === null || typeof err !== "object") return undefined;
  const stack = (err as { stack?: unknown }).stack;
  return typeof stack === "string" ? stack : undefined;
}

// Global runtime error capture (Slice 2). Every handler is wrapped so a
// failure in captureError can NEVER break bootstrap or the app tree.
export function registerGlobalErrorHandlers(): void {
  try {
    window.addEventListener("error", (e: ErrorEvent) => {
      try {
        if (!e.message) return; // skip resource-load noise (no message)
        if (isIntentionalAbort(e.error)) return; // benign cancel, ignore
        void captureError({
          level: "error",
          source: "window.onerror",
          message: e.message,
          stack: errorStack(e.error),
        });
      } catch {
        // swallow — capture must not affect anything
      }
    });

    window.addEventListener(
      "unhandledrejection",
      (e: PromiseRejectionEvent) => {
        try {
          const r: unknown = e.reason;
          if (isIntentionalAbort(r)) return; // benign cancel, ignore
          const isTimeout = r instanceof Error && /timeout/i.test(r.message);
          void captureError({
            level: isTimeout ? "warn" : "error",
            source: "unhandledrejection",
            kind: isTimeout ? "timeout" : undefined,
            message: r instanceof Error ? r.message : String(r),
            stack: r instanceof Error ? r.stack : undefined,
          });
        } catch {
          // swallow
        }
      },
    );
  } catch {
    // if addEventListener itself is unavailable, do not break bootstrap
  }
}

registerGlobalErrorHandlers();

// Guard the render so importing main.tsx in a non-DOM context (e.g. unit
// tests / SSR) does not crash the module — global error handlers above still
// register regardless.
if (typeof document !== "undefined") {
  const rootEl = document.getElementById("root");
  if (rootEl) {
    ReactDOM.createRoot(rootEl).render(
      <React.StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </React.StrictMode>,
    );
  }
}
