// Copies the gitignored r2_config.json next to the Tauri build artifacts so the
// Rust backend (src-tauri/src/r2.rs) can read R2 credentials at runtime without
// them being baked into the binary or exposed to the webview.
//
// Runs before `tauri dev` and `tauri build`. Safe to run repeatedly; skips
// silently if the source config is missing (e.g. on a clean clone without keys).
import { existsSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const src = join(root, "src-tauri", "r2_config.json");

if (!existsSync(src)) {
  console.warn(
    "[copy-r2-config] src-tauri/r2_config.json not found (gitignored) — creating dummy config for Tauri bundler. " +
      "The R2 cover proxy will fall back to local/legacy sources until a config is provided.",
  );
  writeFileSync(src, JSON.stringify({ dummy: true }));
}

const targets = [
  join(root, "src-tauri", "target", "debug"),
  join(root, "src-tauri", "target", "release"),
];

for (const dir of targets) {
  try {
    mkdirSync(dir, { recursive: true });
    copyFileSync(src, join(dir, "r2_config.json"));
    console.log(`[copy-r2-config] copied r2_config.json -> ${dir}`);
  } catch (err) {
    // Non-fatal: build can still proceed; R2 proxy degrades gracefully.
    console.warn(`[copy-r2-config] could not copy to ${dir}: ${err}`);
  }
}
