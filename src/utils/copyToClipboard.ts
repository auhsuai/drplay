import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { captureError } from "./errorLog";

function describeFailure(err: unknown): string {
  return err instanceof Error ? err.message : "unknown";
}

// Why execCommand fallback: deprecated but the only sync copy path where the
// async Clipboard API is unavailable (insecure context / denied permission).
function legacyExecCommandCopy(text: string): boolean {
  const doc = document as unknown as {
    execCommand?: (commandId: string) => boolean;
  };
  // Why a runtime check: jsdom and some WebViews lack execCommand entirely.
  if (typeof doc.execCommand !== "function") return false;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.focus();
  area.select();
  try {
    return doc.execCommand("copy");
  } finally {
    area.remove();
  }
}

export async function copyToClipboard(text: string): Promise<boolean> {
  let tauriReason = "not-attempted";
  try {
    await writeText(text);
    return true;
  } catch (err: unknown) {
    tauriReason = describeFailure(err);
  }

  let webReason = "unavailable";
  try {
    // Why a structural read: the async Clipboard API is secure-context only,
    // so navigator.clipboard may be undefined
    // (MDN: https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/writeText).
    const nav = globalThis as unknown as {
      navigator?: {
        clipboard?: { writeText?: (text: string) => Promise<void> };
      };
    };
    const webClipboard = nav.navigator?.clipboard;
    if (typeof webClipboard?.writeText === "function") {
      await webClipboard.writeText(text);
      return true;
    }
  } catch (err: unknown) {
    webReason = describeFailure(err);
  }

  let execReason = "unavailable";
  try {
    if (legacyExecCommandCopy(text)) return true;
    execReason = "execCommand returned false";
  } catch (err: unknown) {
    execReason = describeFailure(err);
  }

  // Why one combined warn with no text: clipboard content is PII — callers
  // only need to know every backend failed (contract stays Promise<boolean>).
  await captureError({
    level: "warn",
    source: "copyToClipboard",
    message: `all clipboard backends failed (tauri: ${tauriReason}; web: ${webReason}; exec: ${execReason})`,
  });
  return false;
}
