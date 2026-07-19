import React from "react";
import { captureError } from "../utils/errorLog";

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
 * a class component, so the fallback text is intentionally bilingual hardcoded
 * (no extra dependency, no behavior change to the app).
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
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    // Context-only logging. `error` (message/name) and `errorInfo.componentStack`
    // are safe to surface; no credentials/tokens/PII are ever included.
    console.error("[ErrorBoundary]", error, errorInfo);

    // Route the render error into the global error log (Slice 2).
    // Wrapped so a failure in captureError can NEVER loop/crash the boundary.
    try {
      captureError({
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

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div
          role="alert"
          className="fixed inset-0 z-[10002] flex flex-col items-center justify-center gap-6 bg-white px-6 text-center dark:bg-[#121212]"
        >
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            Đã xảy ra lỗi / Something went wrong
          </h1>
          <p className="max-w-md text-gray-600 dark:text-gray-300">
            Ứng dụng gặp lỗi không mong muốn. Vui lòng tải lại trang.
            <br />
            The app hit an unexpected error. Please reload the page.
          </p>
          <button
            type="button"
            onClick={this.handleReload}
            className="rounded-full bg-[#4285F4] px-6 py-3 font-medium text-white shadow-md shadow-blue-500/20 transition-colors hover:bg-blue-600"
          >
            Thử lại / Reload
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
