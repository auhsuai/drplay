// Downloads the latest mpv Windows build (x86_64) from zhongfly/mpv-winbuild
// into src-tauri/bin/mpv-x86_64-pc-windows-msvc.exe — the exact path Tauri
// expects for `bundle.externalBin: ["bin/mpv"]` (tauri-build strips the
// target-triple suffix and stages the exe next to the app binary).
//
// Usage: node scripts/fetch-mpv.mjs [--force]
// Requires: Node >= 18, Windows (tar.exe cannot read 7z/LZMA, so we use the
// standalone 7zr.exe from 7-zip.org, downloaded to a temp dir).
//
// tauri-build FAILS the build when the sidecar binary is missing, so run this
// once after a fresh clone (skipped automatically when the exe already exists
// unless --force is passed).
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  copyFileSync,
  statSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const MPV_WINBUILD_RELEASES_URL =
  "https://api.github.com/repos/zhongfly/mpv-winbuild/releases/latest";
const SEVENZIP_URL = "https://www.7-zip.org/a/7zr.exe";
// zhongfly ships several variants per release; we want the plain x86_64 build
// (no -v3 / -debug / -dev / -lgpl / -aarch64).
const MPV_ASSET_PATTERN = /^mpv-x86_64-\d{8}-git-[0-9a-f]+\.7z$/;
const MIN_MPV_EXE_BYTES = 100 * 1024 * 1024; // real exe is ~114MB
const DOWNLOAD_MAX_TIME_SECS = 1800; // 31MB on a slow link
const CURL_RETRIES = 5;
const HTTP_TIMEOUT_SECS = 60;
const SIDECAR_RELPATH = join(
  "src-tauri",
  "bin",
  "mpv-x86_64-pc-windows-msvc.exe",
);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const sidecarPath = join(repoRoot, SIDECAR_RELPATH);
const workDir = join(tmpdir(), "drplay-mpv-fetch");

function fail(stage, error) {
  console.error(`[fetch-mpv] ${stage} failed: ${error}`);
  process.exit(1);
}

function curl(url, outFile, timeoutSecs, useAuth = false) {
  // curl.exe ships with Windows 10 1803+ and handled GitHub's CDN reliably
  // where other clients were cut off mid-transfer.
  const result = spawnSync(
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
      ...(useAuth && process.env.GITHUB_TOKEN
        ? ["-H", `Authorization: Bearer ${process.env.GITHUB_TOKEN}`]
        : []),
      "-o",
      outFile,
      url,
    ],
    { timeout: (timeoutSecs + CURL_RETRIES * 2) * 1000 },
  );
  if (result.error) fail("download", `${url}: ${result.error.message}`);
  if (result.status !== 0)
    fail("download", `${url}: curl exited ${result.status}: ${result.stderr}`);
}

const force = process.argv.includes("--force");
if (process.platform !== "win32") {
  fail(
    "platform",
    "this script downloads a Windows mpv build; run it on Windows",
  );
}

try {
  if (existsSync(sidecarPath) && !force) {
    console.log(
      `[fetch-mpv] already present: ${sidecarPath} (use --force to re-download)`,
    );
    process.exit(0);
  }

  mkdirSync(workDir, { recursive: true });

  // 1. Latest release metadata
  const releaseTmp = join(workDir, "release.json");
  curl(MPV_WINBUILD_RELEASES_URL, releaseTmp, HTTP_TIMEOUT_SECS, true);
  const release = JSON.parse(readFileSync(releaseTmp, "utf8"));
  if (!release.tag_name || !Array.isArray(release.assets)) {
    fail(
      "release lookup",
      `unexpected GitHub API response for ${MPV_WINBUILD_RELEASES_URL}`,
    );
  }
  const asset = release.assets.find((candidate) =>
    MPV_ASSET_PATTERN.test(candidate.name),
  );
  if (!asset) {
    fail(
      "release lookup",
      `no ${MPV_ASSET_PATTERN} asset in release ${release.tag_name} — check zhongfly/mpv-winbuild asset naming`,
    );
  }
  console.log(
    `[fetch-mpv] release ${release.tag_name}: ${asset.name} (${Math.round(asset.size / 1048576)}MB)`,
  );

  // 2. Standalone extractor (tar.exe cannot read 7z/LZMA)
  const sevenZipPath = join(workDir, "7zr.exe");
  curl(SEVENZIP_URL, sevenZipPath, HTTP_TIMEOUT_SECS);

  // 3. Archive, with exact-size integrity check against the release metadata
  const archivePath = join(workDir, asset.name);
  curl(asset.browser_download_url, archivePath, DOWNLOAD_MAX_TIME_SECS);
  const downloadedBytes = statSync(archivePath).size;
  if (downloadedBytes !== asset.size) {
    fail(
      "download",
      `size mismatch: got ${downloadedBytes} bytes, expected ${asset.size}`,
    );
  }

  // 4. Extract only mpv.exe
  const extractDir = join(workDir, "out");
  rmSync(extractDir, { recursive: true, force: true });
  const extract = spawnSync(
    sevenZipPath,
    ["e", archivePath, "-o" + extractDir, "mpv.exe", "-y"],
    {
      timeout: 10 * 60 * 1000,
    },
  );
  if (extract.error) fail("extract", `7zr.exe: ${extract.error.message}`);
  if (extract.status !== 0)
    fail("extract", `7zr.exe exited ${extract.status}: ${extract.stderr}`);

  // 5. Place the sidecar where tauri-build looks for it
  const extractedPath = join(extractDir, "mpv.exe");
  if (!existsSync(extractedPath))
    fail("extract", "mpv.exe missing from the archive");
  const extractedBytes = statSync(extractedPath).size;
  if (extractedBytes < MIN_MPV_EXE_BYTES) {
    fail("extract", `mpv.exe suspiciously small (${extractedBytes} bytes)`);
  }
  mkdirSync(dirname(sidecarPath), { recursive: true });
  copyFileSync(extractedPath, sidecarPath);
  console.log(
    `[fetch-mpv] done: ${sidecarPath} (${Math.round(statSync(sidecarPath).size / 1048576)}MB)`,
  );
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
