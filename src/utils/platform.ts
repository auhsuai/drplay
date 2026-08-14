/**
 * Mobile-platform detection (Task 9 will upgrade this to @tauri-apps/plugin-os
 * with the same export shape — this regex keeps the decision working even
 * before the plugin is installed, e.g. in jsdom tests and on the web build).
 * Deliberately module-level constant: every consumer reads ONE value per
 * page load, never re-evaluates on hot paths.
 */
export const IS_MOBILE =
  /Android|iPhone|iPad|iPod|webOS|IEMobile|Opera Mini/i.test(
    navigator.userAgent,
  );
