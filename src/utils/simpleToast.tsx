import { captureError } from "./errorLog";

const FADE_OUT_MS = 200;

type ToastVariant = "error" | "success";

const TOAST_DEFAULT_DURATION: Record<ToastVariant, number> = {
  error: 4000,
  success: 3000,
};

function showToast(
  message: string,
  variant: ToastVariant,
  durationOverride?: number,
): void {
  const root = document.getElementById("toast-root");
  if (!root) {
    // fire-and-forget: logging must not throw in this sync path (captureError
    // never rejects — it swallows failures internally).
    void captureError({
      level: "warn",
      source: "simpleToast",
      message: `[Toast fallback] ${message}`,
    });
    return;
  }

  const toastEl = document.createElement("div");
  toastEl.className = `app-toast app-toast--${variant}`;
  toastEl.textContent = message;
  root.appendChild(toastEl);

  let removeTimer: ReturnType<typeof setTimeout> | undefined;
  const removeToast = () => {
    if (removeTimer !== undefined) {
      clearTimeout(removeTimer);
      removeTimer = undefined;
    }
    toastEl.remove();
  };

  const duration = Math.max(
    0,
    durationOverride ?? TOAST_DEFAULT_DURATION[variant],
  );
  setTimeout(() => {
    toastEl.style.opacity = "0";
    toastEl.style.transform = "translateY(10px) scale(0.95)";
    removeTimer = setTimeout(removeToast, FADE_OUT_MS);
  }, duration);
}

export function showErrorToast(
  message: string,
  options?: { duration?: number },
): void {
  showToast(message, "error", options?.duration);
}

export function showSuccessToast(
  message: string,
  options?: { duration?: number },
): void {
  showToast(message, "success", options?.duration);
}
