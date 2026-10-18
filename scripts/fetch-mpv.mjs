// Downloads the PINNED mpv Windows build (x86_64) from zhongfly/mpv-winbuild
// into src-tauri/bin/: the sidecar exe at mpv-x86_64-pc-windows-msvc.exe — the
// exact path Tauri expects for `bundle.externalBin: ["bin/mpv"]` (tauri-build
// strips the target-triple suffix and stages the exe next to the app binary) —
// plus libmpv-2.dll, the in-process engine that production uses by default
// (bundled as a resource; the sidecar stays as its fallback).
//
// The release tag and the sidecar archive SHA-256 are pinned together, so the
// same commit bundles the same engine on every machine (no floating `latest`).
// The -dev archive (libmpv-2.dll) is not pinned by hash but must match the
// GitHub-provided asset digest of the same release.
// zhongfly prunes old releases, so when the pinned tag is gone the script
// falls back to `latest` with a loud warning instead of failing the build.
//
// Usage: node scripts/fetch-mpv.mjs [--force]
// Requires: Node >= 18, Windows (tar.exe cannot read 7z/LZMA, so we use the
// standalone 7zr.exe from 7-zip.org, downloaded to a temp dir).
//
// tauri-build FAILS the build when the sidecar binary is missing, so run this
// once after a fresh clone (skipped automatically when the exe already exists
// unless --force is passed). npm script: `npm run fetch-mpv`.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

const MPV_WINBUILD_TAG = "2026-10-18-fffe7a23a8";
const MPV_WINBUILD_RELEASES_URL =
  "https://api.github.com/repos/zhongfly/mpv-winbuild/releases";
// SHA-256 of mpv-x86_64-20261018-git-fffe7a23a8.7z in that release — matches
// the asset digest GitHub reports (built Oct 18 2026, git fffe7a23a8).
// Bump tag + hash together when upgrading.
const MPV_ASSET_SHA256 =
  "d33039db49bc32c46e5e66b857c39483d87160713ec0cd1e5ee9c4f8862de9d1";
const SEVENZIP_URL = "https://www.7-zip.org/a/7zr.exe";
// zhongfly ships several variants per release; we want the plain x86_64 build
// (no -v3 / -debug / -dev / -lgpl / -aarch64) for the sidecar exe, and the
// matching -dev archive for libmpv-2.dll (the plain one carries no DLL).
const MPV_ASSET_PATTERN = /^mpv-x86_64-\d{8}-git-[0-9a-f]+\.7z$/;
const LIBMPV_ASSET_PATTERN = /^mpv-dev-x86_64-\d{8}-git-[0-9a-f]+\.7z$/;
const MIN_MPV_EXE_BYTES = 100 * 1024 * 1024; // real exe is ~114MB
// The shipped libmpv-2.dll is ~115MB. 80MB is high enough to reject a
// truncated/placeholder file and low enough to tolerate build-size variance.
const MIN_LIBMPV_DLL_BYTES = 80 * 1024 * 1024;
const DOWNLOAD_MAX_TIME_SECS = 1800; // 31MB on a slow link
const CURL_RETRIES = 5;
const HTTP_TIMEOUT_SECS = 60;
const SIDECAR_RELPATH = join(
  "src-tauri",
  "bin",
  "mpv-x86_64-pc-windows-msvc.exe",
);
const LIBMPV_DLL_RELPATH = join("src-tauri", "bin", "libmpv-2.dll");

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const sidecarPath = join(repoRoot, SIDECAR_RELPATH);
const libmpvDllPath = join(repoRoot, LIBMPV_DLL_RELPATH);
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

// Downloads one release asset, enforces the metadata size and (when GitHub
// provides it) its SHA-256 digest, and returns the archive path and hash.
function downloadVerified(asset) {
  const archivePath = join(workDir, asset.name);
  curl(asset.browser_download_url, archivePath, DOWNLOAD_MAX_TIME_SECS);
  const bytes = statSync(archivePath).size;
  if (bytes !== asset.size) {
    fail(
      "download",
      `size mismatch for ${asset.name}: got ${bytes} bytes, expected ${asset.size}`,
    );
  }
  const sha = createHash("sha256")
    .update(readFileSync(archivePath))
    .digest("hex");
  if (asset.digest && asset.digest !== `sha256:${sha}`) {
    fail(
      "download",
      `GitHub asset digest ${asset.digest} does not match ${asset.name} (sha256:${sha})`,
    );
  }
  return { archivePath, sha };
}

function fetchRelease(url) {
  // Metadata lookups must NOT retry 404/410 (terminal, so the caller can fall
  // back); transient errors still get the normal retry via --retry.
  const tmp = join(workDir, "release.json");
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
      "--max-time",
      String(HTTP_TIMEOUT_SECS),
      "-A",
      "drplay-fetch",
      ...(process.env.GITHUB_TOKEN
        ? ["-H", `Authorization: Bearer ${process.env.GITHUB_TOKEN}`]
        : []),
      "-w",
      "%{http_code}",
      "-o",
      tmp,
      url,
    ],
    {
      timeout: (HTTP_TIMEOUT_SECS + CURL_RETRIES * 2) * 1000,
      encoding: "utf8",
    },
  );
  if (result.error) fail("release lookup", `${url}: ${result.error.message}`);
  const httpCode = Number((result.stdout || "").trim());
  if (result.status !== 0) {
    if (httpCode === 404 || httpCode === 410) return null;
    fail(
      "release lookup",
      `${url}: curl exited ${result.status}: ${result.stderr}`,
    );
  }
  return JSON.parse(readFileSync(tmp, "utf8"));
}

const force = process.argv.includes("--force");
if (process.platform !== "win32") {
  fail(
    "platform",
    "this script downloads a Windows mpv build; run it on Windows",
  );
}

try {
  if (existsSync(sidecarPath) && existsSync(libmpvDllPath) && !force) {
    console.log(
      `[fetch-mpv] already present: ${sidecarPath} + ${libmpvDllPath} (use --force to re-download)`,
    );
    process.exit(0);
  }

  mkdirSync(workDir, { recursive: true });

  // 1. Release metadata. zhongfly prunes old releases: a pinned tag that no
  // longer exists upstream (404/410) falls back to `latest` with a loud
  // warning; any other lookup error still fails the build.
  const requestedTag = process.env.MPV_TAG?.trim() || MPV_WINBUILD_TAG;
  let release = fetchRelease(
    `${MPV_WINBUILD_RELEASES_URL}/tags/${requestedTag}`,
  );
  let fellBackToLatest = false;
  if (!release) {
    fellBackToLatest = true;
    release = fetchRelease(`${MPV_WINBUILD_RELEASES_URL}/latest`);
    if (!release)
      fail("release lookup", "latest release lookup returned 404/410");
  }
  if (!release.tag_name || !Array.isArray(release.assets)) {
    fail(
      "release lookup",
      `unexpected GitHub API response (tag ${release.tag_name ?? "unknown"})`,
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
  if (fellBackToLatest) {
    console.warn(
      `[fetch-mpv] WARNING: pinned tag ${requestedTag} no longer exists upstream (pruned).`,
    );
    console.warn(
      `[fetch-mpv] WARNING: falling back to latest ${release.tag_name} (${asset.name}, ${asset.digest || "no digest"}).`,
    );
    console.warn(
      "[fetch-mpv] WARNING: re-pin MPV_WINBUILD_TAG + MPV_ASSET_SHA256 to keep builds reproducible.",
    );
  }
  const usingPinnedRelease = release.tag_name === MPV_WINBUILD_TAG;
  console.log(
    `[fetch-mpv] release ${release.tag_name}: ${asset.name} (${Math.round(asset.size / 1048576)}MB)`,
  );

  // 2. Standalone extractor (tar.exe cannot read 7z/LZMA)
  const sevenZipPath = join(workDir, "7zr.exe");
  curl(SEVENZIP_URL, sevenZipPath, HTTP_TIMEOUT_SECS);

  // 3. Archives: zhongfly ships the engine (mpv.exe) and the libmpv SDK
  // (libmpv-2.dll) as SEPARATE assets of the same release; both are downloaded
  // so the sidecar and the in-process engine are the same build. Each download
  // is size-checked against the release metadata, then SHA-256 checked. The
  // pinned plain archive must match MPV_ASSET_SHA256; the -dev archive is
  // anchored to the GitHub-provided digest (there is no second pin constant).
  const { archivePath, sha: actualSha } = downloadVerified(asset);
  if (usingPinnedRelease) {
    if (actualSha !== MPV_ASSET_SHA256) {
      fail(
        "download",
        `SHA-256 mismatch for ${asset.name}: got ${actualSha}, expected ${MPV_ASSET_SHA256}`,
      );
    }
  } else if (!asset.digest) {
    fail(
      "download",
      `release ${release.tag_name} has no asset digest; refusing unverified archive — re-pin MPV_WINBUILD_TAG`,
    );
  }
  console.log(`[fetch-mpv] sha256 verified: ${actualSha}`);

  const libmpvAsset = release.assets.find((candidate) =>
    LIBMPV_ASSET_PATTERN.test(candidate.name),
  );
  if (!libmpvAsset) {
    fail(
      "release lookup",
      `no ${LIBMPV_ASSET_PATTERN} asset in release ${release.tag_name} — libmpv-2.dll ships only in the -dev archive`,
    );
  }
  if (!libmpvAsset.digest) {
    fail(
      "download",
      `release ${release.tag_name} has no asset digest for ${libmpvAsset.name}; refusing an unverified libmpv archive`,
    );
  }
  const { archivePath: libmpvArchivePath, sha: libmpvSha } =
    downloadVerified(libmpvAsset);
  console.log(
    `[fetch-mpv] libmpv archive verified: ${libmpvAsset.name} (${Math.round(libmpvAsset.size / 1048576)}MB, sha256 ${libmpvSha})`,
  );

  // 4. Extract mpv.exe from the plain archive
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
    fail(
      "extract",
      `7zr.exe exited ${extract.status} extracting mpv.exe: ${extract.stderr}`,
    );

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
    `[fetch-mpv] sidecar: ${sidecarPath} (${Math.round(statSync(sidecarPath).size / 1048576)}MB)`,
  );

  // 6. Extract libmpv-2.dll from the -dev archive and place it next to the
  // sidecar (tauri.conf.json bundles it as a resource next to the exe).
  const extractDll = spawnSync(
    sevenZipPath,
    ["e", libmpvArchivePath, "-o" + extractDir, "libmpv-2.dll", "-y"],
    {
      timeout: 10 * 60 * 1000,
    },
  );
  if (extractDll.error)
    fail("extract", `7zr.exe (libmpv archive): ${extractDll.error.message}`);
  if (extractDll.status !== 0)
    fail(
      "extract",
      `7zr.exe exited ${extractDll.status} extracting libmpv-2.dll: ${extractDll.stderr}`,
    );
  const extractedDllPath = join(extractDir, "libmpv-2.dll");
  if (!existsSync(extractedDllPath))
    fail(
      "extract",
      "libmpv-2.dll missing from the -dev archive — production libmpv needs it, refusing to continue",
    );
  const extractedDllBytes = statSync(extractedDllPath).size;
  if (extractedDllBytes < MIN_LIBMPV_DLL_BYTES) {
    fail(
      "extract",
      `libmpv-2.dll suspiciously small (${extractedDllBytes} bytes, expected at least ${MIN_LIBMPV_DLL_BYTES})`,
    );
  }
  copyFileSync(extractedDllPath, libmpvDllPath);
  console.log(
    `[fetch-mpv] libmpv DLL: ${libmpvDllPath} (${Math.round(statSync(libmpvDllPath).size / 1048576)}MB)`,
  );
  console.log("[fetch-mpv] done");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
