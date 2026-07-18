/**
 * Text-only clipboard write with a deprecated execCommand fallback for
 * webviews (e.g. Tauri) where navigator.clipboard is unavailable.
 *
 * SECURITY: only ever writes plain text via writeText / a textarea value.
 * Never write an HTML blob — the browser would NOT interpret it as markup,
 * but text-only keeps the contract unambiguous and XSS-safe.
 */

export async function copyToClipboard(text: string): Promise<boolean> {
  // Modern, async-clipboard API (requires secure context / user gesture).
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) {
    // Fall through to execCommand fallback. Do not log the text (may contain
    // sensitive-but-sanitized user data). Log only module + coarse reason.
    console.warn("[copyToClipboard] navigator.clipboard.writeText failed, trying fallback", {
      module: "copyToClipboard",
      timestamp: new Date().toISOString(),
      reason: err instanceof Error ? err.message : "unknown",
    });
  }

  // Fallback: textarea + execCommand('copy'). Deprecated but still works in
  // many embedded webviews. Source: MDN "Interact with the clipboard".
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
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
