export function showErrorToast(message: string, options?: { duration?: number }) {
  const root = document.getElementById('toast-root');
  if (!root) {
    console.error('[Toast fallback]', message);
    return;
  }

  const toastEl = document.createElement('div');
  toastEl.className = 'app-toast app-toast--error';
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
