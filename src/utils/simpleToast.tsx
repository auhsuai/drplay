export function showErrorToast(message: string, options?: { duration?: number }) {
  const root = document.getElementById('toast-root');
  if (!root) {
    console.error('[Toast fallback]', message);
    return;
  }

  const toastEl = document.createElement('div');
  toastEl.className = 'app-toast app-toast--error';
  // WAI-ARIA ARIA22 (w3.org): role="status" is an implicit aria-live="polite"
  // region, so a screen reader announces the message without needing focus
  // moved to it. Adding aria-live explicitly too, per MDN's own guidance, for
  // broader assistive-tech compatibility. Not role="alert"/assertive — these
  // toasts auto-dismiss and aren't the "must interrupt immediately" case that
  // warrants it (and combining alert+aria-live causes double-speaking in some
  // screen readers).
  toastEl.setAttribute('role', 'status');
  toastEl.setAttribute('aria-live', 'polite');
  toastEl.textContent = message;
  root.appendChild(toastEl);

  setTimeout(() => {
    toastEl.style.opacity = '0';
    toastEl.style.transform = 'translateY(10px) scale(0.95)';
    setTimeout(() => {
      toastEl.remove();
    }, 200); // fade out duration
  }, options?.duration ?? 4000);
}

export function showSuccessToast(message: string, options?: { duration?: number }) {
  const root = document.getElementById('toast-root');
  if (!root) {
    console.error('[Toast fallback]', message);
    return;
  }
  const toastEl = document.createElement('div');
  toastEl.className = 'app-toast app-toast--success';
  toastEl.setAttribute('role', 'status');
  toastEl.setAttribute('aria-live', 'polite');
  toastEl.textContent = message;
  root.appendChild(toastEl);
  setTimeout(() => {
    toastEl.style.opacity = '0';
    toastEl.style.transform = 'translateY(10px) scale(0.95)';
    setTimeout(() => { toastEl.remove(); }, 200);
  }, options?.duration ?? 3000);
}
