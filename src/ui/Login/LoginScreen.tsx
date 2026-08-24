import { useState, useEffect, useRef } from "react";
import { HardDrive, LoaderCircle } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { showErrorToast } from "../../utils/simpleToast";
import { captureError } from "../../utils/errorLog";
import { IS_MOBILE } from "../../utils/platform";

const LOGIN_MODULE = "LoginScreen";
const CANCEL_PROMPT_MS = 5000;
const TIMEOUT_MATCH = /timeout|timed out/;

// Classify a login error for observability. Returns name + message only.
function classifyLoginError(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err;
  const message = err instanceof Error ? err.message : String(err);
  return `${name}: ${message}`;
}

// Best-effort teardown of the Rust-side Google login waiter (mobile only):
// cancel_google_login bumps the native generation so the pending auth loop
// exits immediately with "Login cancelled" instead of waiting for the OS
// browser flow to end on its own. Failure is intentionally swallowed:
// correctness is already guaranteed TS-side by the attemptRef supersede
// gates below, so a failed cancel only means Rust keeps waiting a little
// longer — no state change, no user-facing error. Same fire-and-forget
// shape as void wipePersistedMetadataCache().catch(...) in useAuth.
async function cancelGoogleLogin(): Promise<void> {
  try {
    await invoke("cancel_google_login");
  } catch {
    // Intentionally silent — see the block comment above.
  }
}

interface LoginResult {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

interface LoginScreenProps {
  onLogin: (tokens: LoginResult) => void;
}

export function LoginScreen({ onLogin }: LoginScreenProps) {
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(false);
  const [showCancel, setShowCancel] = useState(false);
  // Monotonic id of the in-flight login attempt. Anything that makes the
  // pending attempt obsolete — user cancel, unmount — bumps the counter, and
  // a newer attempt captures its own id on click, so every late resolution
  // of an abandoned attempt is dropped below (intentionally silent: an
  // OAuth session nobody is waiting for must never reach onLogin or state).
  const attemptRef = useRef(0);

  useEffect(() => {
    // Unmount invalidates the pending attempt — its late resolve/reject
    // would otherwise still fire onLogin after this screen is gone.
    return () => {
      attemptRef.current += 1;
      // Stop the native waiter as well (see cancelGoogleLogin). StrictMode
      // double-mounts in dev fire this twice — cancel_google_login is
      // idempotent (no-op when nothing is pending).
      if (IS_MOBILE) void cancelGoogleLogin();
    };
  }, []);

  // The cancel prompt resets the moment loading stops — adjusted during
  // render (React "adjusting state during render" pattern) instead of
  // calling setState synchronously inside the effect below.
  if (!isLoading && showCancel) setShowCancel(false);

  useEffect(() => {
    if (!isLoading) return;
    const timer = setTimeout(() => {
      setShowCancel(true);
    }, CANCEL_PROMPT_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [isLoading]);

  const handleCancel = () => {
    // Invalidate the pending attempt — its late resolution is dropped below.
    attemptRef.current += 1;
    // Tell the Rust side to stop waiting too. Mobile only: desktop's
    // loopback-server flow has no cancellable native waiter. Fire-and-forget —
    // the cancel UX below must run regardless of the IPC outcome.
    if (IS_MOBILE) void cancelGoogleLogin();
    setIsLoading(false);
    setShowCancel(false);
    showErrorToast(t("login.cancelled_by_user"));
  };

  const handleLoginClick = async () => {
    if (isLoading) return;
    const myAttempt = ++attemptRef.current;

    try {
      setIsLoading(true);
      // Mobile (Android) logs in via system browser + custom-scheme deep link
      // (RFC 8252, login_google_mobile); desktop keeps the localhost loopback
      // server (login_google_native). Both return the same token payload.
      const command = IS_MOBILE ? "login_google_mobile" : "login_google_native";
      const token = await invoke<LoginResult>(command);
      if (myAttempt !== attemptRef.current) {
        // Superseded/cancelled/unmounted — drop silently ON PURPOSE: no state
        // change, no onLogin, no extra toast, no error log for a stale result.
        return;
      }
      setIsLoading(false);
      // Forward the full token payload — dropping refresh_token here starves
      // the refresh machinery (apiClient.getValidToken), which later triggers
      // an 'auth-logout' ~50 min after login (regression from 80c2984).
      onLogin(token);
    } catch (error) {
      if (myAttempt !== attemptRef.current) {
        // Stale attempt — same silent drop as the success path above.
        return;
      }
      setIsLoading(false);
      const errStr = String(error);
      if (errStr.includes("cancel")) {
        showErrorToast(t("login.cancelled"));
        void captureError({
          level: "warn",
          source: LOGIN_MODULE,
          kind: "login-cancelled",
          message: `login-cancelled: ${classifyLoginError(error)}`,
        });
      } else if (TIMEOUT_MATCH.test(errStr)) {
        showErrorToast(t("login.timeout_error"));
        void captureError({
          level: "warn",
          source: LOGIN_MODULE,
          kind: "login-timeout",
          message: `login-timeout: ${classifyLoginError(error)}`,
        });
      } else if (
        errStr.includes("ANDROID_CLIENT_ID") ||
        errStr.includes("not configured")
      ) {
        showErrorToast(
          t("login.mobile_not_configured", {
            defaultValue:
              "Google login chưa được cấu hình trên thiết bị này — cần OAuth client Android trên Google Console",
          }),
        );
        void captureError({
          level: "warn",
          source: LOGIN_MODULE,
          kind: "login-not-configured",
          message: `login-not-configured: ${classifyLoginError(error)}`,
        });
      } else {
        showErrorToast(t("login.failed"));
        void captureError({
          level: "error",
          source: LOGIN_MODULE,
          kind: "login-failed",
          message: `login-failed: ${classifyLoginError(error)}`,
        });
      }
    }
  };

  return (
    <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-white/10 dark:bg-black/30 backdrop-blur-2xl">
      <div className="w-full max-w-md p-8 bg-white/70 dark:bg-[#202124]/60 backdrop-blur-3xl rounded-3xl shadow-[0_8px_32px_rgba(0,0,0,0.4)] text-center">
        <div className="flex justify-center mb-6">
          <div className="w-16 h-16 bg-brand-primary/10 rounded-2xl flex items-center justify-center text-brand-primary">
            <HardDrive className="w-8 h-8" />
          </div>
        </div>

        <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
          {t("login.welcome")}
        </h1>
        <p className="text-gray-500 dark:text-gray-400 mb-8 text-sm">
          {t("login.description")}
        </p>

        {/* Google Brand Button */}
        <button
          onClick={() => {
            void handleLoginClick();
          }}
          disabled={isLoading}
          className="w-full flex items-center justify-center gap-3 bg-white text-gray-700 font-medium py-3 px-4 rounded-lg shadow-[0_1px_3px_rgba(0,0,0,0.1)] hover:shadow-[0_2px_6px_rgba(0,0,0,0.15)] hover:bg-gray-50 focus:bg-gray-50 focus:outline-none focus:ring-4 focus:ring-brand-primary/30 active:scale-[0.98] transition-all duration-200 disabled:opacity-70 disabled:cursor-not-allowed"
        >
          {isLoading ? (
            <LoaderCircle className="w-6 h-6 animate-spin text-brand-primary" />
          ) : (
            <>
              {/* Google G Logo SVG */}
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M22.56 12.25C22.56 11.47 22.49 10.72 22.36 10H12V14.26H17.92C17.67 15.63 16.86 16.79 15.69 17.57V20.34H19.26C21.36 18.42 22.56 15.6 22.56 12.25Z"
                  fill="#4285F4"
                />
                <path
                  d="M12 23C14.97 23 17.46 22.02 19.26 20.34L15.69 17.57C14.71 18.23 13.46 18.63 12 18.63C9.18001 18.63 6.79001 16.73 5.92001 14.18H2.23001V17.04C4.04001 20.62 7.72001 23 12 23Z"
                  fill="#34A853"
                />
                <path
                  d="M5.92001 14.18C5.69001 13.52 5.56001 12.78 5.56001 12C5.56001 11.22 5.69001 10.48 5.92001 9.82V6.96H2.23001C1.49001 8.44 1.05001 10.15 1.05001 12C1.05001 13.85 1.49001 15.56 2.23001 17.04L5.92001 14.18Z"
                  fill="#FBBC05"
                />
                <path
                  d="M12 5.38C13.62 5.38 15.06 5.93 16.2 7.02L19.34 3.88C17.45 2.12 14.97 1.05 12 1.05C7.72001 1.05 4.04001 3.38 2.23001 6.96L5.92001 9.82C6.79001 7.27 9.18001 5.38 12 5.38Z"
                  fill="#EA4335"
                />
              </svg>
              {t("login.connect_button")}
            </>
          )}
        </button>

        {showCancel && (
          <p className="mt-4 text-sm text-gray-500 dark:text-gray-400 animate-in fade-in duration-300">
            {t("login.error_question")}{" "}
            <button
              type="button"
              onClick={handleCancel}
              className="text-brand-primary underline cursor-pointer hover:text-blue-600 transition-colors"
            >
              {t("login.cancel_here")}
            </button>
          </p>
        )}

        {IS_MOBILE && isLoading && (
          <p className="mt-4 text-sm text-gray-500 dark:text-gray-400 animate-in fade-in duration-300">
            {t(
              "login.mobile_browser_opened",
              "Đã mở trình duyệt — chờ đăng nhập...",
            )}
          </p>
        )}
      </div>
    </div>
  );
}
