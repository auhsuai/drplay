import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { captureError } from "./errorLog";

const FALLBACK_STYLE_POSITION = "fixed";
const FALLBACK_STYLE_LEFT = "-9999px";
const FALLBACK_STYLE_TOP = "-9999px";

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await writeText(text);
    return true;
  } catch (err: unknown) {
    await captureError({
      level: "warn",
      source: "copyToClipboard",
      message: `Tauri clipboard failed: ${err instanceof Error ? err.message : "unknown"}`,
    });
  }

  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = FALLBACK_STYLE_POSITION;
    ta.style.left = FALLBACK_STYLE_LEFT;
    ta.style.top = FALLBACK_STYLE_TOP;
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- intentional last-resort fallback: execCommand works synchronously in webviews where navigator.clipboard is unavailable (Tauri webview on older Windows); the modern API already failed above.
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch (err: unknown) {
    await captureError({
      level: "error",
      source: "copyToClipboard",
      message: `Fallback clipboard failed: ${err instanceof Error ? err.message : "unknown"}`,
    });
    return false;
  }
}
