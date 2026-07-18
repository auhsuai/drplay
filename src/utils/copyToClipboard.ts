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
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "-9999px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch (err) {
    console.error("[copyToClipboard] fallback failed", {
      module: "copyToClipboard",
      timestamp: new Date().toISOString(),
      reason: err instanceof Error ? err.message : "unknown",
    });
    return false;
  }
}
