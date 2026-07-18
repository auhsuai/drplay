import React from "react";
import ReactDOM from "react-dom/client";
import "./i18n";
import App from "./App";
import { Buffer } from "buffer";
import { initLogger } from "./utils/logger";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { captureError } from "./utils/errorLog";

initLogger();

// Global runtime error capture (Slice 2). Every handler is wrapped so a
// failure in captureError can NEVER break bootstrap or the app tree.
export function registerGlobalErrorHandlers(): void {
  try {
    window.addEventListener("error", (e: ErrorEvent) => {
      try {
        if (!e.message) return; // skip resource-load noise (no message)
        captureError({
          level: "error",
          source: "window.onerror",
          message: e.message ?? String(e),
          stack: e.error?.stack,
        });
      } catch {
        // swallow — capture must not affect anything
      }
    });

    window.addEventListener(
      "unhandledrejection",
      (e: PromiseRejectionEvent) => {
        try {
          const r = e.reason;
          captureError({
            level: "error",
            source: "unhandledrejection",
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

if (typeof window !== "undefined") {
  (window as any).Buffer = Buffer;
}

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
