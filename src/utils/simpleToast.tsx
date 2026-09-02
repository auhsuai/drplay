const FADE_OUT_MS = 200;

type ToastVariant = "error" | "success";

const TOAST_DEFAULT_DURATION: Record<ToastVariant, number> = {
  error: 4000,
  success: 3000,
};

// At most one toast is ever shown: a new showToast replaces the previous one
// immediately. Module-level refs track the active toast and its pending
// timers so replacement can cancel them. Removals are additionally guarded
// by activeToastEl identity, so no stale timer can ever remove the toast
// that replaced it.
let activeToastEl: HTMLElement | null = null;
let activeFadeOutTimer: ReturnType<typeof setTimeout> | undefined;
let activeRemoveTimer: ReturnType<typeof setTimeout> | undefined;

function clearActiveToastTimers(): void {
  if (activeFadeOutTimer !== undefined) {
    clearTimeout(activeFadeOutTimer);
    activeFadeOutTimer = undefined;
  }
  if (activeRemoveTimer !== undefined) {
    clearTimeout(activeRemoveTimer);
    activeRemoveTimer = undefined;
  }
}

function showToast(
  message: string,
  variant: ToastVariant,
  durationOverride?: number,
): void {
  // Mounted on document.body (NOT #content-area): the AppShell content
  // wrapper carries a scale property, which always forms its own stacking
  // context — a toast inside #content-area can never compete with the
  // root-context overlays (z-[9999]) no matter its z-index. On body as the
  // last DOM node, z-index 9999 wins the tie against those overlays.
  // (document.body always exists per the DOM spec — no fallback needed.)
  const root = document.body;

  // Replace the previous toast right away: cancel its timers and remove it
  // from the DOM so only one toast is ever visible at a time.
  clearActiveToastTimers();
  if (activeToastEl !== null) {
    activeToastEl.remove();
    activeToastEl = null;
  }

  const toastEl = document.createElement("div");
  toastEl.className = `app-toast app-toast--${variant}`;
  toastEl.textContent = message;
  root.appendChild(toastEl);
  activeToastEl = toastEl;

  const removeToast = () => {
    if (activeRemoveTimer !== undefined) {
      clearTimeout(activeRemoveTimer);
      activeRemoveTimer = undefined;
    }
    if (activeToastEl === toastEl) {
      toastEl.remove();
      activeToastEl = null;
    }
  };

  const duration = Math.max(
    0,
    durationOverride ?? TOAST_DEFAULT_DURATION[variant],
  );
  activeFadeOutTimer = setTimeout(() => {
    if (activeToastEl !== toastEl) {
      return;
    }
    activeFadeOutTimer = undefined;
    toastEl.style.opacity = "0";
    toastEl.style.transform = "translateY(10px) scale(0.95)";
    activeRemoveTimer = setTimeout(removeToast, FADE_OUT_MS);
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
