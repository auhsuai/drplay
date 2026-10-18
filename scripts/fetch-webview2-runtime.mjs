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
// webview layer render path deterministic. Bump RUNTIME_VERSION and CAB_SHA256
// together.
//
// Source: Microsoft's own fixed-version .cab, resolved from the download page at
// run time. Do NOT go back to NuGet's WebView2.Runtime.X64 "mirror".
// webview2.runtime.x64.154.0.4258.62.nupkg is 103,138,555 bytes with a
// matching SHA-256, which is exactly why the old mirror looked trustworthy — but
// it is a strict subset of the real runtime: 58 files / 182,031,650 bytes
// against the cab's 257 files / 701,153,191, with zero files of its own. It
// drops msedge.dll (349,905,736 bytes — the actual browser engine), plus
// d3dcompiler_47.dll, dxcompiler.dll and 167 of the 168 Locales. The mirror's
// msedgewebview2.exe still reports FileVersion 154.0.4258.62 because that exe is
// only a thin launcher, so every cheap identity check passes on a runtime that
// cannot spawn a browser process at all (Chromium RESULT_CODE_MISSING_DATA,
// surfaced by Tauri as HRESULT(0x80080005) "Server execution failed"). A correct
// FileVersion therefore proves nothing on its own — the completeness gate at the
// bottom is what actually catches this class of bug.
//
// Usage: node scripts/fetch-webview2-runtime.mjs [--force]
// Requires: Node >= 18, Windows (curl.exe and expand.exe both ship with it).
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
// The folder name is a contract with tauri.conf.json (which hardcodes this
// path), not a free choice — it must keep matching RUNTIME_VERSION so the two
// cannot drift apart silently.
const RUNTIME_FOLDER = `Microsoft.WebView2.FixedVersionRuntime.${RUNTIME_VERSION}.x64`;
const RUNTIME_EXE = "msedgewebview2.exe";
// The cab is the fixed-version distribution Microsoft documents at
// learn.microsoft.com/.../concepts/distribution ("decompress with
// `expand {pkg} -F:* {dest}`"), and its root folder is already named exactly
// RUNTIME_FOLDER, so the version identity of the payload is decided by
// Microsoft rather than by anything we construct.
const CAB_NAME = `Microsoft.WebView2.FixedVersionRuntime.${RUNTIME_VERSION}.x64.cab`;
const CAB_HOST =
  "https://msedge.sf.dl.delivery.mp.microsoft.com/filestreamingservice/files/";
// The page is server-rendered (Nuxt), so the per-(version, arch) cab URLs sit in
// the inline __NUXT__ payload as JSON-escaped strings — no browser needed. They
// are NOT stable: each is a CDN file token that Microsoft rotates on re-publish,
// so we resolve the URL every run instead of hardcoding a GUID. The file is
// installed per-machine at "C:\Program Files (x86)\Microsoft\EdgeWebView\
// Application\<version>\" and can be copied anywhere without admin rights; that
// is the fallback this script no longer needs, since the cab needs no install.
const DOWNLOAD_PAGE =
  "https://developer.microsoft.com/en-us/microsoft-edge/webview2/";
// SHA-256 of Microsoft.WebView2.FixedVersionRuntime.154.0.4258.62.x64.cab
// (308,020,625 bytes). Pinned: the URL above rotates but the build does not, so
// a re-publish that changes the payload must fail loudly instead of shipping an
// unverified engine. Re-pin together with RUNTIME_VERSION.
const CAB_SHA256 =
  "e8f55a4bde27c7f82512402b56a58539b5ec8928be4e500e077b6f66c9ef4668";
// Docs put the fixed-version binaries at "over 250 MB"; the real cab is ~294 MB.
const MIN_CAB_BYTES = 250 * 1024 * 1024;
const MIN_EXE_BYTES = 4 * 1024 * 1024; // real exe is ~4.9MB
// Measured file counts for the same 154.0.4258.62 build: the broken NuGet mirror
// has 58, this cab has 257, and the Evergreen-installed copy of the neighbouring
// 155.0.4283.62 has 916. A floor of 200 keeps ~22% headroom under the real thing
// while staying 3.4x above the mirror, which is the whole point of this gate.
const MIN_RUNTIME_FILES = 200;
const DOWNLOAD_MAX_TIME_SECS = 900;
const PAGE_MAX_TIME_SECS = 120;
const CURL_RETRIES = 5;
const EXTRACT_TIMEOUT_MS = 15 * 60 * 1000;
const VERSION_CHECK_TIMEOUT_MS = 60 * 1000;

// `expand.exe` must be the Windows one. A bare `expand.exe` resolves to GNU
// coreutils expand on this machine (Git for Windows is ahead of System32 in
// PATH) and dies with "expand: unknown option -- F".
const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
const expandExe = join(systemRoot, "System32", "expand.exe");

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const runtimeDir = join(repoRoot, "src-tauri", RUNTIME_FOLDER);
const workDir = join(tmpdir(), "drplay-webview2-fetch");

// Unwinds to the top-level handler, which owns cleanup and the exit code. These
// paths deliberately throw instead of calling process.exit: process.exit skips
// `finally`, so failing after the 308 MB cab lands would strand ~1 GB of staging
// in %TEMP% on every attempt.
class Abort extends Error {}

function fail(stage, error) {
  console.error(`[fetch-webview2] ${stage} failed: ${error}`);
  throw new Abort();
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

function walk(root) {
  // fs.glob is still experimental on Node 22 (CI) and readdirSync({recursive})
  // only landed in 18.17, so recurse by hand.
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      const sub = walk(full);
      files += sub.files;
      bytes += sub.bytes;
    } else {
      files += 1;
      bytes += statSync(full).size;
    }
  }
  return { files, bytes };
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

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

// The single source of truth for "is this folder a usable runtime". Every check
// is printed, including the ones that pass, because the failure mode this script
// exists to prevent is a runtime that looks fine in a directory listing.
function auditRuntime(dir) {
  const failures = [];
  const report = [`[fetch-webview2] completeness gate: ${dir}`];
  const check = (ok, label) => {
    report.push(`  [${ok ? "ok  " : "FAIL"}] ${label}`);
    if (!ok) failures.push(label);
    return ok;
  };
  // Emitted in one write, on one stream: Node flushes a piped stdout
  // asynchronously but stderr synchronously, so interleaving the two lands the
  // summary in the middle of the report whenever the output is redirected.
  const publish = () => console.log(report.join("\n"));

  const exePath = join(dir, RUNTIME_EXE);
  if (check(existsSync(exePath), `${RUNTIME_EXE} present`)) {
    const exeBytes = statSync(exePath).size;
    check(
      exeBytes >= MIN_EXE_BYTES,
      `${RUNTIME_EXE} size ${exeBytes.toLocaleString()} bytes >= ${MIN_EXE_BYTES.toLocaleString()}`,
    );
    const fileVersion = readFileVersion(exePath);
    check(
      fileVersion === RUNTIME_VERSION,
      `${RUNTIME_EXE} FileVersion ${fileVersion} === ${RUNTIME_VERSION}`,
    );
  }

  // Chromium renamed the V8 startup snapshot from snapshot_blob.bin to
  // v8_context_snapshot.bin years ago; neither the cab's 154.0.4258.62 nor the
  // Evergreen-installed 155.0.4283.62 on this machine has the old name, so accept
  // either and never require a file real builds stopped shipping.
  const snapshot = ["v8_context_snapshot.bin", "snapshot_blob.bin"].find(
    (name) => existsSync(join(dir, name)),
  );
  check(
    Boolean(snapshot),
    `V8 snapshot blob present (${snapshot ?? "none found"})`,
  );

  // The decisive check. msedgewebview2.exe is a thin launcher; msedge.dll is the
  // ~350 MB engine it has to hand off to. The broken NuGet mirror omits it
  // entirely, which is what turns "FileVersion matches" into a runtime that can
  // never spawn a browser process.
  const engine = join(dir, "msedge.dll");
  check(
    existsSync(engine),
    existsSync(engine)
      ? `msedge.dll present (${statSync(engine).size.toLocaleString()} bytes)`
      : "msedge.dll present (the browser engine — absent from the NuGet mirror)",
  );

  // Present in Microsoft's cab, absent from the mirror.
  check(
    existsSync(join(dir, "d3dcompiler_47.dll")),
    "d3dcompiler_47.dll present",
  );

  // Both payloads ship exactly one EBWebView/x64 file, so this is a guard against
  // a partially extracted tree rather than a mirror detector.
  check(
    existsSync(join(dir, "EBWebView", "x64", "EmbeddedBrowserWebView.dll")),
    "EBWebView/x64/EmbeddedBrowserWebView.dll present",
  );

  const { files } = walk(dir);
  check(
    files >= MIN_RUNTIME_FILES,
    `file count ${files.toLocaleString()} >= ${MIN_RUNTIME_FILES}`,
  );

  publish();
  return failures;
}

function resolveCabUrl() {
  const pagePath = join(workDir, "download-page.html");
  curl(DOWNLOAD_PAGE, pagePath, PAGE_MAX_TIME_SECS);
  // The __NUXT__ payload writes every slash as the six-character JSON escape
  // below, so a naive URL match finds nothing; unescape before looking for the
  // cab.
  const page = readFileSync(pagePath, "utf8").replaceAll("\\u002F", "/");
  const url = page.match(
    new RegExp(`${CAB_HOST}[0-9a-f-]+/${CAB_NAME.replaceAll(".", "\\.")}`),
  )?.[0];
  if (!url) {
    const offered = [
      ...new Set(
        [...page.matchAll(/FixedVersionRuntime\.([\d.]+)\.x64\.cab/g)].map(
          (m) => m[1],
        ),
      ),
    ];
    fail(
      "source",
      `${CAB_NAME} is not offered by ${DOWNLOAD_PAGE} right now (x64 versions listed: ${
        offered.join(", ") || "none"
      }). Microsoft only ships the latest and second-latest majors; pick one of those, or drop a cab you already have into ${runtimeDir} by hand.`,
    );
  }
  console.log(`[fetch-webview2] cab resolved: ${url}`);
  return url;
}

// One write, so the verdict lands directly under the report it refers to. The
// non-zero exit is what marks the run as failed.
function reportFailure(headline, failures, action) {
  console.log(
    [headline, ...failures.map((failure) => `  - ${failure}`), action]
      .filter(Boolean)
      .join("\n"),
  );
  throw new Abort();
}

const force = process.argv.includes("--force");

function main() {
  if (process.platform !== "win32") {
    fail(
      "platform",
      "this script downloads the Windows WebView2 runtime; run it on Windows",
    );
  }
  mkdirSync(workDir, { recursive: true });

  // 1. Already provisioned? The gate decides, not the mere presence of an .exe —
  // that is the mistake that let a 58-file mirror pass unnoticed. A folder that
  // fails here is left untouched and reported; `--force` is the repair path.
  if (!force && existsSync(join(runtimeDir, RUNTIME_EXE))) {
    const failures = auditRuntime(runtimeDir);
    if (failures.length === 0) {
      console.log(
        `[fetch-webview2] already present and complete: ${runtimeDir} (use --force to re-download)`,
      );
      printDevUsage();
      return;
    }
    reportFailure(
      `[fetch-webview2] ${RUNTIME_FOLDER} failed the completeness gate:`,
      failures,
      `[fetch-webview2] re-run with --force to replace it with the pinned ${RUNTIME_VERSION}.`,
    );
  }

  // 2. Archive — the hashed payload is the integrity gate, the size floor only
  // turns a truncated download into an obvious message instead of a hash miss.
  const cabUrl = resolveCabUrl();
  const cabPath = join(workDir, CAB_NAME);
  curl(cabUrl, cabPath, DOWNLOAD_MAX_TIME_SECS);
  const downloadedBytes = statSync(cabPath).size;
  if (downloadedBytes < MIN_CAB_BYTES) {
    fail(
      "download",
      `${cabUrl} is only ${downloadedBytes} bytes — got an error page instead of the runtime?`,
    );
  }
  const actualSha = sha256(cabPath);
  if (actualSha !== CAB_SHA256) {
    fail(
      "hash",
      `SHA-256 mismatch for ${cabUrl}: got ${actualSha}, expected ${CAB_SHA256}`,
    );
  }
  console.log(
    `[fetch-webview2] sha256 verified: ${actualSha} (${downloadedBytes.toLocaleString()} bytes)`,
  );

  // 3. Unpack into staging. Expanding straight into runtimeDir would merge the new
  // tree into the old one and leave stale files behind — the folder in this repo
  // currently carries both 154.0.4258.62.manifest and 155.0.4283.62.manifest —
  // so the destination is wiped and repopulated only after staging passes.
  const extractDir = join(workDir, "out");
  mkdirSync(extractDir, { recursive: true });
  run(expandExe, ["-F:*", cabPath, extractDir], "extract", EXTRACT_TIMEOUT_MS);

  const stagedDir = join(extractDir, RUNTIME_FOLDER);
  if (!existsSync(stagedDir)) {
    fail(
      "extract",
      `the cab did not expand to ${RUNTIME_FOLDER}; Microsoft renamed the root folder — check the archive before trusting it`,
    );
  }

  // 4. Gate the staged tree before it is allowed to replace anything.
  const staged = auditRuntime(stagedDir);
  if (staged.length > 0) {
    reportFailure(
      `[fetch-webview2] the runtime in ${cabUrl} is incomplete; ${runtimeDir} was left untouched:`,
      staged,
    );
  }

  rmSync(runtimeDir, { recursive: true, force: true });
  mkdirSync(dirname(runtimeDir), { recursive: true });
  cpSync(stagedDir, runtimeDir, { recursive: true });

  // 5. Re-gate the delivered folder, and remove it if the copy went wrong — a
  // partial runtime must never survive for tauri-build to embed.
  const delivered = auditRuntime(runtimeDir);
  if (delivered.length > 0) {
    rmSync(runtimeDir, { recursive: true, force: true });
    reportFailure(
      `[fetch-webview2] the runtime written to ${RUNTIME_FOLDER} failed the gate and was removed, so nothing broken is left in place:`,
      delivered,
    );
  }
  console.log(`[fetch-webview2] done: ${runtimeDir}`);

  printDevUsage();
}

try {
  main();
  process.exitCode = 0;
} catch (error) {
  if (!(error instanceof Abort)) {
    console.error(
      `[fetch-webview2] unexpected failed: ${error?.stack ?? error}`,
    );
  }
  process.exitCode = 1;
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

function printDevUsage() {
  // The pinned runtime is not picked up automatically in dev — print the
  // commands so nobody has to guess the env var names.
  console.log("");
  console.log(
    "[fetch-webview2] dev usage (the pinned runtime is not automatic):",
  );
  console.log(`  $env:WEBVIEW2_BROWSER_EXECUTABLE_FOLDER = "${runtimeDir}"`);
  console.log(
    '  $env:DRPLAY_PLAYER_ENGINE = "libmpv"   # only for the new engine',
  );
  console.log("  npm run tauri dev");
}
