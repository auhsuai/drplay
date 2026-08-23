import React from "react";
import { captureError } from "../utils/errorLog";
import i18n from "../i18n";

/**
 * Top-level React Error Boundary (React 19 pattern).
 *
 * React render errors are NOT caught by try/catch — only an Error Boundary
 * class component (getDerivedStateFromError + componentDidCatch) can catch them
 * and prevent a silent full-UI crash.
 *
 * Source: https://react.dev/reference/react/Component#catching-rendering-errors-with-an-error-boundary
 *         https://react.dev/reference/react/Component#static-getderivedstatefromerror
 *         (also cited in REFACTOR_MASTER_PLAN.md — "Chuẩn tham chiếu 2026", Finding #2)
 *
 * i18n note: react-i18next `useTranslation`/`t()` are hooks and cannot run inside
 * a class component, so the fallback UI reads the shared i18n instance directly
 * (initialized in src/i18n.ts, imported before App in main.tsx). Fallbacks stay
 * English so the boundary renders readable text even if a locale key is missing.
 *
 * variant="compact": region-scoped fallback (short title + Reload button) for
 * boundaries that only own a SUBTREE — e.g. the tab content area in AppShell.
 * A tab-level chunk/render failure must not blank out the whole app: the
 * compact fallback keeps the surrounding chrome alive. It deliberately offers
 * ONLY a full page reload, never retry-in-place: React.lazy caches rejections
 * for the document's lifetime (react.dev/reference/react/lazy), so remounting
 * would just replay the cached failure. Default (no prop) stays the original
 * fullscreen overlay used at app-root (main.tsx).
 *
 * Error-handling standard (AGENTS.md Luật 4):
 * - componentDidCatch logs with context ([ErrorBoundary]) but ONLY the error and
 *   React's errorInfo (component stack). It never logs secrets, tokens, cookies,
 *   or PII — neither is present in `error`/`errorInfo` by construction.
 */

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Omit at app-root (fullscreen overlay); "compact" scopes the fallback to a subtree. */
  variant?: "compact";
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    // Context-only logging. `error` (message/name) and `errorInfo.componentStack`
    // are safe to surface; no credentials/tokens/PII are ever included.
    console.error("[ErrorBoundary]", error, errorInfo);

    // Route the render error into the global error log (Slice 2).
    // Wrapped so a failure in captureError can NEVER loop/crash the boundary.
    try {
      void captureError({
        level: "error",
        source: "ErrorBoundary",
        message: error.message,
        stack: error.stack,
      });
    } catch {
      // ignore — capture must never break error recovery
    }
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  override render(): React.ReactNode {
    if (this.state.hasError) {
      if (this.props.variant === "compact") {
        return (
          <div
            role="alert"
            className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
          >
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
              {i18n.t("error.title")}
            </h2>
            <button
              type="button"
              onClick={this.handleReload}
              className="rounded-full bg-brand-primary px-4 py-2 text-sm font-medium text-white shadow-md shadow-blue-500/20 transition-colors hover:bg-blue-600"
            >
              {i18n.t("error.reload")}
            </button>
          </div>
        );
      }
      return (
        <div
          role="alert"
          className="fixed inset-0 z-[10002] flex flex-col items-center justify-center gap-6 bg-white px-6 text-center dark:bg-[#121212]"
        >
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            {i18n.t("error.title")}
          </h1>
          <p className="max-w-md text-gray-600 dark:text-gray-300">
            {i18n.t("error.description")}
          </p>
          <button
            type="button"
            onClick={this.handleReload}
            className="rounded-full bg-brand-primary px-6 py-3 font-medium text-white shadow-md shadow-blue-500/20 transition-colors hover:bg-blue-600"
          >
            {i18n.t("error.reload")}
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
