import { useState, useEffect } from "react";
import { HardDrive, Loader2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { showErrorToast } from "../../utils/simpleToast";
import { captureError } from "../../utils/errorLog";

const LOGIN_MODULE = "LoginScreen";
const CANCEL_PROMPT_MS = 5000;
const TIMEOUT_MATCH = /timeout|timed out/;

// Classify a login error for observability. Returns name + message only.
function classifyLoginError(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err;
  const message = err instanceof Error ? err.message : String(err);
  return `${name}: ${message}`;
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

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    if (isLoading) {
      timer = setTimeout(() => {
        setShowCancel(true);
      }, CANCEL_PROMPT_MS);
    } else {
      setShowCancel(false);
    }
    return () => clearTimeout(timer);
  }, [isLoading]);

  const handleCancel = () => {
    setIsLoading(false);
    setShowCancel(false);
    showErrorToast(t('login.cancelled_by_user', 'Đã hủy thao tác kết nối.'));
  };

  const handleLoginClick = async () => {
    if (isLoading) return;
    
    try {
      setIsLoading(true);
      // Call Rust backend directly
      const token = await invoke<LoginResult>("login_google_native");
      setIsLoading(false);
      // Forward the full token payload — dropping refresh_token here starves
      // the refresh machinery (apiClient.getValidToken), which later triggers
      // an 'auth-logout' ~50 min after login (regression from 80c2984).
      onLogin(token);
    } catch (error) {
      setIsLoading(false);
      const errStr = String(error);
      if (errStr.includes('cancel')) {
        showErrorToast(t('login.cancelled', 'Đăng nhập đã bị hủy'));
        captureError({
          level: 'warn',
          source: LOGIN_MODULE,
          kind: 'login-cancelled',
          message: `login-cancelled: ${classifyLoginError(error)}`
        });
      } else if (TIMEOUT_MATCH.test(errStr)) {
        showErrorToast(t('login.timeout_error', 'Đăng nhập quá thời gian chờ, vui lòng thử lại.'));
        captureError({
          level: 'warn',
          source: LOGIN_MODULE,
          kind: 'login-timeout',
          message: `login-timeout: ${classifyLoginError(error)}`
        });
      } else {
        showErrorToast(t('login.failed', 'Đăng nhập thất bại, vui lòng thử lại.'));
        captureError({
          level: 'error',
          source: LOGIN_MODULE,
          kind: 'login-failed',
          message: `login-failed: ${classifyLoginError(error)}`
        });
      }
    }
  };

  return (
    <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-white/10 dark:bg-black/30 backdrop-blur-2xl">
      <div className="w-full max-w-md p-8 bg-white/70 dark:bg-[#202124]/60 backdrop-blur-3xl rounded-3xl shadow-[0_8px_32px_rgba(0,0,0,0.4)] text-center">
        <div className="flex justify-center mb-6">
          <div className="w-16 h-16 bg-[#4285F4]/10 rounded-2xl flex items-center justify-center text-[#4285F4]">
            <HardDrive className="w-8 h-8" />
          </div>
        </div>
        
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
          {t('login.welcome')}
        </h1>
        <p className="text-gray-500 dark:text-gray-400 mb-8 text-sm">
          {t('login.description')}
        </p>

        {/* Google Brand Button */}
        <button
          onClick={handleLoginClick}
          disabled={isLoading}
          className="w-full flex items-center justify-center gap-3 bg-white text-gray-700 font-medium py-3 px-4 rounded-lg shadow-[0_1px_3px_rgba(0,0,0,0.1)] hover:shadow-[0_2px_6px_rgba(0,0,0,0.15)] hover:bg-gray-50 focus:bg-gray-50 focus:outline-none focus:ring-4 focus:ring-[#4285F4]/30 active:scale-[0.98] transition-all duration-200 disabled:opacity-70 disabled:cursor-not-allowed"
        >
          {isLoading ? (
            <Loader2 className="w-6 h-6 animate-spin text-[#4285F4]" />
          ) : (
            <>
              {/* Google G Logo SVG */}
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M22.56 12.25C22.56 11.47 22.49 10.72 22.36 10H12V14.26H17.92C17.67 15.63 16.86 16.79 15.69 17.57V20.34H19.26C21.36 18.42 22.56 15.6 22.56 12.25Z" fill="#4285F4"/>
                <path d="M12 23C14.97 23 17.46 22.02 19.26 20.34L15.69 17.57C14.71 18.23 13.46 18.63 12 18.63C9.18001 18.63 6.79001 16.73 5.92001 14.18H2.23001V17.04C4.04001 20.62 7.72001 23 12 23Z" fill="#34A853"/>
                <path d="M5.92001 14.18C5.69001 13.52 5.56001 12.78 5.56001 12C5.56001 11.22 5.69001 10.48 5.92001 9.82V6.96H2.23001C1.49001 8.44 1.05001 10.15 1.05001 12C1.05001 13.85 1.49001 15.56 2.23001 17.04L5.92001 14.18Z" fill="#FBBC05"/>
                <path d="M12 5.38C13.62 5.38 15.06 5.93 16.2 7.02L19.34 3.88C17.45 2.12 14.97 1.05 12 1.05C7.72001 1.05 4.04001 3.38 2.23001 6.96L5.92001 9.82C6.79001 7.27 9.18001 5.38 12 5.38Z" fill="#EA4335"/>
              </svg>
              {t('login.connect_button')}
            </>
          )}
        </button>

        {showCancel && (
          <p className="mt-4 text-sm text-gray-500 dark:text-gray-400 animate-in fade-in duration-300">
            {t('login.error_question', 'Có lỗi?')} <button type="button" onClick={handleCancel} className="text-[#4285F4] underline cursor-pointer hover:text-blue-600 transition-colors">{t('login.cancel_here', 'Hủy ở đây')}</button>
          </p>
        )}
      </div>
    </div>
  );
}
