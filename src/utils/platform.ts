/**
 * Mobile-platform detection (Task 9 will upgrade this to @tauri-apps/plugin-os
 * with the same export shape — this regex keeps the decision working even
 * before the plugin is installed, e.g. in jsdom tests and on the web build).
 * Deliberately module-level constant: every consumer reads ONE value per
 * page load, never re-evaluates on hot paths.
 *
 * iPadOS 13+ Safari reports a desktop-class UA ("Macintosh ... Mobile/...",
 * no iPad token — Apple Developer Forums thread 119186), so the UA regex
 * alone misclassifies iPads as desktop. The industry-standard fallback is
 * touch-point detection (MDN: Navigator.maxTouchPoints — desktops without a
 * touchscreen report 0, phones/tablets typically 5), checked as
 * platform === "MacIntel" && maxTouchPoints > 1, plus the
 * navigator.userAgentData mobile/platform hint where available (MDN:
 * Navigator.userAgentData — experimental, Chromium-only, so only a hint).
 */

const MOBILE_UA = /Android|iPhone|iPad|iPod|webOS|IEMobile|Opera Mini/i;

// UA Client-Hints platform tokens that always mean a handheld device.
// (Chromium values: "Android", "iOS", "macOS", "Windows", ... — Safari does
// not implement userAgentData at all, hence hint-only.)
const MOBILE_UA_DATA_PLATFORM = /^(Android|iOS)$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function computeIsMobile(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav: unknown = navigator;
  if (!isRecord(nav)) return false;

  const ua: unknown = nav["userAgent"];
  const uaString = typeof ua === "string" ? ua : "";
  if (MOBILE_UA.test(uaString)) return true;

  const uaData: unknown = nav["userAgentData"];
  if (isRecord(uaData)) {
    if (uaData["mobile"] === true) return true;
    const uaPlatform: unknown = uaData["platform"];
    if (
      typeof uaPlatform === "string" &&
      MOBILE_UA_DATA_PLATFORM.test(uaPlatform)
    ) {
      return true;
    }
  }

  // iPadOS desktop-class UA comes in two flavours: navigator.platform stays
  // "MacIntel" while maxTouchPoints is > 1, and the UA carries both the
  // "Macintosh" and "Mobile" tokens. Either signal (with touch) means iPad.
  // Touchscreen Windows laptops (platform "Win32", no Mobile token) and
  // plain Mac desktops (maxTouchPoints 0) stay desktop.
  const touch: unknown = nav["maxTouchPoints"];
  const touchPoints =
    typeof touch === "number" && Number.isFinite(touch) ? touch : 0;
  if (touchPoints > 1) {
    const platformValue: unknown = nav["platform"];
    if (platformValue === "MacIntel") return true;
    if (/Macintosh/i.test(uaString) && /Mobile/i.test(uaString)) return true;
  }

  return false;
}

export const IS_MOBILE: boolean = computeIsMobile();
