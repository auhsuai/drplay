import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { captureError } from "./errorLog";

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await writeText(text);
    return true;
  } catch (err: unknown) {
    await captureError({
      level: "error",
      source: "copyToClipboard",
      message: `Tauri clipboard failed: ${err instanceof Error ? err.message : "unknown"}`,
    });
    return false;
  }
}
