import { writeText } from '@tauri-apps/plugin-clipboard-manager';

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await writeText(text);
    return true;
  } catch (err) {
    console.warn("[copyToClipboard] Tauri clipboard failed, trying fallback", {
      module: "copyToClipboard",
      timestamp: new Date().toISOString(),
      reason: err instanceof Error ? err.message : "unknown",
    });
  }

  try {
    // navigator.clipboard is reliably available in Tauri's WebView2/WKWebView/
    // WebKitGTK — document.execCommand("copy") is deprecated (MDN: "This
    // feature is no longer recommended") and unnecessary here.
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    console.error("[copyToClipboard] fallback failed", {
      module: "copyToClipboard",
      timestamp: new Date().toISOString(),
      reason: err instanceof Error ? err.message : "unknown",
    });
    return false;
  }
}
