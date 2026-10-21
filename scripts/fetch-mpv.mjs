// Downloads the PINNED mpv Windows build (x86_64) from zhongfly/mpv-winbuild
// into src-tauri/bin/: the sidecar exe at mpv-x86_64-pc-windows-msvc.exe (the
// exact path Tauri expects for `bundle.externalBin: ["bin/mpv"]`) plus
// libmpv-2.dll, the in-process engine that production uses by default.
//
// The release tag and both archive SHA-256 values are pinned together, so the
// same commit bundles the same engine on every machine. zhongfly prunes old
// releases, so when the pinned tag is gone the script falls back to `latest`
// with a loud warning instead of failing the build.
//
// Mirror support: set MPV_RELEASES_URL to a GitHub-compatible releases API base
// (for example a DrPlay-controlled mirror repo). Asset names and pinned hashes
// still apply; this only changes where metadata and archives are fetched from.
// Production defaults stay pinned to the upstream release below.
//
// Usage: node scripts/fetch-mpv.mjs [--force]
// Requires: Node >= 18, Windows.
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
  (process.env.MPV_RELEASES_URL || "").trim() ||
  "https://api.github.com/repos/zhongfly/mpv-winbuild/releases";
// SHA-256 of mpv-x86_64-20261018-git-fffe7a23a8.7z (33,611,100 bytes).
// Verified against the upstream release digest and the extracted mpv.exe
// (mpv v0.41.0-1206-gfffe7a23a8, built Oct 18 2026).
const MPV_ASSET_SHA256 =
  "53eabe4d795021d1760e93567084da0c1eea22b624b1c9a43cbc39409a35b93b";
// SHA-256 of mpv-dev-x86_64-20261018-git-fffe7a23a8.7z (32,820,724 bytes),
// which carries libmpv-2.dll (121,942,016 bytes).
const LIBMPV_ASSET_SHA256 =
  "0cfad5691390aad3efd90f1714102b29b88ee623c6143d98485dee20a91aab50";
const SEVENZIP_URL = "https://www.7-zip.org/a/7zr.exe";
const MPV_ASSET_PATTERN = /^mpv-x86_64-\d{8}-git-[0-9a-f]+\.7z$/;
const LIBMPV_ASSET_PATTERN = /^mpv-dev-x86_64-\d{8}-git-[0-9a-f]+\.7z$/;
const MIN_MPV_EXE_BYTES = 100 * 1024 * 1024;
const MIN_LIBMPV_DLL_BYTES = 80 * 1024 * 1024;
const DOWNLOAD_MAX_TIME_SECS = 1800;
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

class Abort extends Error {}

function fail(stage, error) {
  console.error(`[fetch-mpv] ${stage} failed: ${error}`);
  throw new Abort();
}

function curl(url, outFile, timeoutSecs) {
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
      ...(process.env.GITHUB_TOKEN
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

function downloadVerified(asset) {
  const archivePath = join(workDir, asset.name);
  curl(asset.browser_download_url, archivePath, DOWNLOAD_MAX_TIME_SECS);
  const bytes = statSync(archivePath).size;
  if (bytes !== asset.size) {
    fail(
      "download",
      `${asset.name}: size mismatch got ${bytes} bytes, expected ${asset.size} (url ${asset.browser_download_url})`,
    );
  }
  const sha = createHash("sha256")
    .update(readFileSync(archivePath))
    .digest("hex");
  if (asset.digest && asset.digest !== `sha256:${sha}`) {
    fail(
      "download",
      `${asset.name}: GitHub asset digest ${asset.digest} does not match downloaded content sha256:${sha} (url ${asset.browser_download_url})`,
    );
  }
  return { archivePath, sha };
}

function fetchRelease(url) {
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

function main() {
  if (process.platform !== "win32") {
    fail(
      "platform",
      "this script downloads a Windows mpv build; run it on Windows",
    );
  }

  if (existsSync(sidecarPath) && existsSync(libmpvDllPath) && !force) {
    console.log(
      `[fetch-mpv] already present: ${sidecarPath} + ${libmpvDllPath} (use --force to re-download)`,
    );
    return;
  }

  mkdirSync(workDir, { recursive: true });

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
      `no ${MPV_ASSET_PATTERN} asset in release ${release.tag_name} (releases url ${MPV_WINBUILD_RELEASES_URL})`,
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

  const sevenZipPath = join(workDir, "7zr.exe");
  curl(SEVENZIP_URL, sevenZipPath, HTTP_TIMEOUT_SECS);

  const { archivePath, sha: actualSha } = downloadVerified(asset);
  if (usingPinnedRelease) {
    if (actualSha !== MPV_ASSET_SHA256) {
      fail(
        "download",
        `SHA-256 mismatch for ${asset.name}: got ${actualSha}, expected ${MPV_ASSET_SHA256} (tag ${release.tag_name}, url ${asset.browser_download_url})`,
      );
    }
  } else if (!asset.digest) {
    fail(
      "download",
      `release ${release.tag_name} has no asset digest for ${asset.name}; refusing unverified archive (url ${asset.browser_download_url})`,
    );
  }
  console.log(`[fetch-mpv] sha256 verified: ${actualSha}`);

  const libmpvAsset = release.assets.find((candidate) =>
    LIBMPV_ASSET_PATTERN.test(candidate.name),
  );
  if (!libmpvAsset) {
    fail(
      "release lookup",
      `no ${LIBMPV_ASSET_PATTERN} asset in release ${release.tag_name} (url ${MPV_WINBUILD_RELEASES_URL})`,
    );
  }
  if (!libmpvAsset.digest) {
    fail(
      "download",
      `release ${release.tag_name} has no asset digest for ${libmpvAsset.name}; refusing an unverified libmpv archive (url ${libmpvAsset.browser_download_url})`,
    );
  }
  const { archivePath: libmpvArchivePath, sha: libmpvSha } =
    downloadVerified(libmpvAsset);
  if (usingPinnedRelease && libmpvSha !== LIBMPV_ASSET_SHA256) {
    fail(
      "download",
      `SHA-256 mismatch for ${libmpvAsset.name}: got ${libmpvSha}, expected ${LIBMPV_ASSET_SHA256} (tag ${release.tag_name}, url ${libmpvAsset.browser_download_url})`,
    );
  }
  console.log(
    `[fetch-mpv] libmpv archive verified: ${libmpvAsset.name} (${Math.round(libmpvAsset.size / 1048576)}MB, sha256 ${libmpvSha})`,
  );

  const extractDir = join(workDir, "out");
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });

  const extract = spawnSync(
    sevenZipPath,
    ["e", archivePath, "-o" + extractDir, "mpv.exe", "-y"],
    { timeout: 10 * 60 * 1000 },
  );
  if (extract.error) fail("extract", `7zr.exe: ${extract.error.message}`);
  if (extract.status !== 0)
    fail(
      "extract",
      `7zr.exe exited ${extract.status} extracting mpv.exe: ${extract.stderr}`,
    );

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

  const extractDll = spawnSync(
    sevenZipPath,
    ["e", libmpvArchivePath, "-o" + extractDir, "libmpv-2.dll", "-y"],
    { timeout: 10 * 60 * 1000 },
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
      "libmpv-2.dll missing from the -dev archive; production libmpv needs it, refusing to continue",
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
}

try {
  main();
  process.exitCode = 0;
} catch (error) {
  if (!(error instanceof Abort)) {
    console.error(`[fetch-mpv] unexpected failure: ${error?.stack ?? error}`);
  }
  process.exitCode = 1;
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
