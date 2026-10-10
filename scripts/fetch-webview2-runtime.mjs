// Downloads the PINNED WebView2 Fixed Version Runtime (x64) 154.0.4258.62 into
// src-tauri/Microsoft.WebView2.FixedVersionRuntime.154.0.4258.62.x64/ — the
// folder path referenced by `bundle.windows.webviewInstallMode` in
// src-tauri/tauri.conf.json. tauri-build embeds that folder in the MSI and the
// installer points WEBVIEW2_BROWSER_EXECUTABLE_FOLDER at it, so the app always
// runs on this exact runtime no matter which Evergreen version happens to be
// installed on the machine.
//
// Why pin: the Evergreen runtime auto-updated 154.0.4258.62 -> 155.0.4283.45 on
// a dev machine and broke video rendering for the libmpv engine (black video,
// audio still playing). Pinning keeps the DirectComposition / transparent
// webview layer render path deterministic. Bump RUNTIME_VERSION and
// NUPKG_SHA256 together.
//
// Usage: node scripts/fetch-webview2-runtime.mjs [--force]
// Requires: Node >= 18, Windows (curl.exe, tar.exe and expand.exe all ship
// with it).
//
// Dev note: tauri-runtime-wry only loads a fixed runtime when
// WEBVIEW2_BROWSER_EXECUTABLE_FOLDER is set (see tauri-apps/tauri#13817), so
// the standalone installer uses the pinned runtime automatically but `tauri dev`
// needs the variable exported by hand — the script prints those commands.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  cpSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const RUNTIME_VERSION = "154.0.4258.62";
const RUNTIME_FOLDER = `Microsoft.WebView2.FixedVersionRuntime.${RUNTIME_VERSION}.x64`;
const RUNTIME_EXE = "msedgewebview2.exe";
// NuGet's WebView2.Runtime.X64 mirror ships the fixed runtime already extracted
// under this path inside the package (unlike Microsoft's .cab, see the .cab
// fallback below).
const NUPKG_SOURCE_SUBPATH = "contentFiles/any/any/WebView2";
const NUPKG_URL = `https://api.nuget.org/v3-flatcontainer/webview2.runtime.x64/${RUNTIME_VERSION}/webview2.runtime.x64.${RUNTIME_VERSION}.nupkg`;
// SHA-256 of webview2.runtime.x64.154.0.4258.62.nupkg (103,138,555 bytes). The
// real Microsoft download page renders with JS and exposes no scriptable URL, so
// we mirror via NuGet and pin the digest of what we verified: the extracted
// msedgewebview2.exe reports FileVersion 154.0.4258.62.
const NUPKG_SHA256 =
  "5809f362575d23727074264223e67c5395829b9c3db5ad4db924261f88976837";
const MIN_NUPKG_BYTES = 90 * 1024 * 1024; // real package is ~103MB
const MIN_EXE_BYTES = 4 * 1024 * 1024; // real exe is ~4.9MB
const DOWNLOAD_MAX_TIME_SECS = 600;
const CURL_RETRIES = 5;
const EXTRACT_TIMEOUT_MS = 10 * 60 * 1000;
const VERSION_CHECK_TIMEOUT_MS = 60 * 1000;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const runtimeDir = join(repoRoot, "src-tauri", RUNTIME_FOLDER);
const workDir = join(tmpdir(), "drplay-webview2-fetch");

function fail(stage, error) {
  console.error(`[fetch-webview2] ${stage} failed: ${error}`);
  process.exit(1);
}

// Wraps a value in a PowerShell single-quoted literal (doubles embedded quotes).
function psLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function run(command, args, stage, timeoutMs) {
  const result = spawnSync(command, args, { timeout: timeoutMs });
  if (result.error) fail(stage, `${command}: ${result.error.message}`);
  if (result.status !== 0)
    fail(stage, `${command} exited ${result.status}: ${result.stderr}`);
  return result;
}

function curl(url, outFile, timeoutSecs) {
  // curl.exe ships with Windows 10 1803+ and handled NuGet's CDN reliably where
  // other clients were cut off mid-transfer.
  run(
    "curl.exe",
    [
      "-L",
      "--fail",
      "--silent",
      "--show-error",
      "--retry",
      String(CURL_RETRIES),
      "--retry-delay",
      "2",
      "--retry-all-errors",
      "--max-time",
      String(timeoutSecs),
      "-A",
      "drplay-fetch",
      "-o",
      outFile,
      url,
    ],
    "download",
    (timeoutSecs + CURL_RETRIES * 2) * 1000,
  );
}

// Recursive extension filter — fs.glob is still experimental on Node 22 (CI).
function findByExtension(root, extension) {
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) found.push(...findByExtension(full, extension));
    else if (entry.name.toLowerCase().endsWith(extension)) found.push(full);
  }
  return found;
}

function readFileVersion(exePath) {
  const result = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `(Get-Item -LiteralPath ${psLiteral(exePath)}).VersionInfo.FileVersion`,
    ],
    { timeout: VERSION_CHECK_TIMEOUT_MS },
  );
  if (result.error) fail("version", `powershell: ${result.error.message}`);
  if (result.status !== 0)
    fail("version", `powershell exited ${result.status}: ${result.stderr}`);
  return result.stdout.toString().trim();
}

const force = process.argv.includes("--force");
if (process.platform !== "win32") {
  fail(
    "platform",
    "this script downloads the Windows WebView2 runtime; run it on Windows",
  );
}

try {
  const exePath = join(runtimeDir, RUNTIME_EXE);
  if (existsSync(exePath) && !force) {
    console.log(
      `[fetch-webview2] already present: ${exePath} (use --force to re-download)`,
    );
    process.exit(0);
  }

  mkdirSync(workDir, { recursive: true });

  // 1. Archive — the hashed payload is the integrity gate, the size floor only
  // turns a truncated download into an obvious message instead of a hash miss.
  const nupkgPath = join(
    workDir,
    `webview2.runtime.x64.${RUNTIME_VERSION}.nupkg`,
  );
  curl(NUPKG_URL, nupkgPath, DOWNLOAD_MAX_TIME_SECS);
  const downloadedBytes = statSync(nupkgPath).size;
  if (downloadedBytes < MIN_NUPKG_BYTES) {
    fail(
      "download",
      `${NUPKG_URL} is only ${downloadedBytes} bytes — got an error page instead of the runtime?`,
    );
  }
  const actualSha = createHash("sha256")
    .update(readFileSync(nupkgPath))
    .digest("hex");
  if (actualSha !== NUPKG_SHA256) {
    fail(
      "hash",
      `SHA-256 mismatch for ${NUPKG_URL}: got ${actualSha}, expected ${NUPKG_SHA256}`,
    );
  }
  console.log(`[fetch-webview2] sha256 verified: ${actualSha}`);

  // 2. Unpack the nupkg (a zip) — tar.exe reads it without a renamed copy.
  const extractDir = join(workDir, "out");
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  run(
    "tar.exe",
    ["-xf", nupkgPath, "-C", extractDir],
    "extract",
    EXTRACT_TIMEOUT_MS,
  );

  // 3. Stage the runtime tree where tauri-build expects the folder. Prefer the
  // .cab form (what Microsoft's own download ships) and fall back to NuGet's
  // pre-extracted layout, so a future release switching either way still works.
  const cabs = findByExtension(extractDir, ".cab");
  if (cabs.length > 0) {
    mkdirSync(runtimeDir, { recursive: true });
    run(
      "expand.exe",
      ["-F:*", cabs[0], runtimeDir],
      "extract",
      EXTRACT_TIMEOUT_MS,
    );
  } else {
    const sourceDir = join(extractDir, NUPKG_SOURCE_SUBPATH);
    if (!existsSync(join(sourceDir, RUNTIME_EXE))) {
      fail(
        "extract",
        `no .cab and no ${NUPKG_SOURCE_SUBPATH} in ${NUPKG_URL} — mirror layout changed`,
      );
    }
    rmSync(runtimeDir, { recursive: true, force: true });
    mkdirSync(dirname(runtimeDir), { recursive: true });
    cpSync(sourceDir, runtimeDir, { recursive: true });
  }

  // 4. Verify the deliverable actually is the pinned version.
  if (!existsSync(exePath)) {
    fail("extract", `${RUNTIME_EXE} missing from the extracted runtime`);
  }
  const exeBytes = statSync(exePath).size;
  if (exeBytes < MIN_EXE_BYTES) {
    fail("extract", `${RUNTIME_EXE} suspiciously small (${exeBytes} bytes)`);
  }
  const fileVersion = readFileVersion(exePath);
  if (fileVersion !== RUNTIME_VERSION) {
    fail(
      "version",
      `expected ${RUNTIME_VERSION}, got ${fileVersion} from ${exePath}`,
    );
  }
  console.log(`[fetch-webview2] version verified: ${fileVersion}`);

  // 5. The pinned runtime is not picked up automatically in dev — print the
  // commands so nobody has to guess the env var names.
  console.log(`[fetch-webview2] done: ${runtimeDir}`);
  console.log("");
  console.log(
    "[fetch-webview2] dev usage (the pinned runtime is not automatic):",
  );
  console.log(`  $env:WEBVIEW2_BROWSER_EXECUTABLE_FOLDER = "${runtimeDir}"`);
  console.log(
    '  $env:DRPLAY_PLAYER_ENGINE = "libmpv"   # only for the new engine',
  );
  console.log("  npm run tauri dev");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
