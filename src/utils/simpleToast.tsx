const FADE_OUT_MS = 200;

type ToastVariant = "error" | "success" | "info";

const TOAST_DEFAULT_DURATION: Record<ToastVariant, number> = {
  error: 4000,
  success: 3000,
  info: 3000,
};

// Lucide icon paths (same glyphs as DownloadToast's getToastIcon): a toast
// must show its kind by icon as well as by background colour, so an error
// is never mistaken for a success.
const TOAST_ICON_SVG: Record<ToastVariant, string> = {
  error:
    '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>',
  success:
    '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>',
  info: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="16" y2="12"/><line x1="12" x2="12.01" y1="8" y2="8"/></svg>',
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
  // ARIA live region (WCAG 4.1.3): errors announce assertively, successes
  // politely. The empty region must be in the DOM BEFORE its content changes,
  // otherwise screen readers do not announce the mutation.
  toastEl.setAttribute("role", variant === "error" ? "alert" : "status");
  const iconEl = document.createElement("span");
  iconEl.setAttribute("aria-hidden", "true");
  iconEl.innerHTML = TOAST_ICON_SVG[variant];
  const textEl = document.createElement("span");
  textEl.textContent = message;
  toastEl.append(iconEl, textEl);
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

/** Neutral, non-error notices (user-cancelled actions, partial success). */
export function showInfoToast(
  message: string,
  options?: { duration?: number },
): void {
  showToast(message, "info", options?.duration);
}
