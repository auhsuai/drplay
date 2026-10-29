// Downloads the PINNED mpv Windows build (x86_64) from zhongfly/mpv-winbuild
// into src-tauri/bin/.
//
// MODES (production is libmpv-only):
//   node scripts/fetch-mpv.mjs                  libmpv only  <- default (production/CI)
//   node scripts/fetch-mpv.mjs --libmpv-only    explicit alias of the default
//   node scripts/fetch-mpv.mjs --with-sidecar   libmpv + mpv.exe sidecar (dev/integration)
//   node scripts/fetch-mpv.mjs --sidecar        same as --with-sidecar
//   append --force to re-download the artifacts selected by the mode
//
// Production bundles only libmpv-2.dll (`bundle.resources` in tauri.conf.json).
// The MSI no longer ships mpv.exe because `bundle.externalBin` is empty; users
// install the external mpv player on demand from Settings. The sidecar exe is
// therefore a DEVELOPMENT/integration artifact only: its pin below is dev-only,
// and the default (production) path never resolves, downloads, verifies or
// touches it. Idempotence is per-mode: libmpv mode is satisfied by a valid
// libmpv-2.dll alone, regardless of whether the sidecar exists.
//
// The release tag, both archive SHA-256 values, the asset name patterns, the
// extracted-size floors and the 7-Zip helper hash are pinned together in the
// METADATA block below, so the same commit stages the same bytes on every
// machine and a version bump is a single-block edit. zhongfly prunes old
// releases, so when the pinned tag is gone the script falls back to `latest`
// with a loud warning instead of failing the build.
//
// Mirror support: set MPV_RELEASES_URL to a GitHub-compatible releases API base
// (for example a DrPlay-controlled mirror repo). Asset names and pinned hashes
// still apply; this only changes where metadata and archives are fetched from.
// Production defaults stay pinned to the upstream release below.
//
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

// ---------------------------------------------------------------------------
// METADATA — bump a release by editing THIS BLOCK ONLY.
// ---------------------------------------------------------------------------
const MPV_WINBUILD_TAG = "2026-10-18-fffe7a23a8";
const MPV_WINBUILD_RELEASES_URL =
  (process.env.MPV_RELEASES_URL || "").trim() ||
  "https://api.github.com/repos/zhongfly/mpv-winbuild/releases";

// SHA-256 of mpv-x86_64-20261018-git-fffe7a23a8.7z (33,611,100 bytes).
// Verified against the upstream release digest and the extracted mpv.exe
// (mpv v0.41.0-1206-gfffe7a23a8, built Oct 18 2026). DEV ONLY — the production
// path never downloads this archive.
const MPV_ASSET_SHA256 =
  "53eabe4d795021d1760e93567084da0c1eea22b624b1c9a43cbc39409a35b93b";
const MPV_ASSET_PATTERN = /^mpv-x86_64-\d{8}-git-[0-9a-f]+\.7z$/;
const MIN_MPV_EXE_BYTES = 100 * 1024 * 1024;

// SHA-256 of mpv-dev-x86_64-20261018-git-fffe7a23a8.7z (32,820,724 bytes),
// which carries libmpv-2.dll (121,942,016 bytes). Production artifact.
const LIBMPV_ASSET_SHA256 =
  "0cfad5691390aad3efd90f1714102b29b88ee623c6143d98485dee20a91aab50";
const LIBMPV_ASSET_PATTERN = /^mpv-dev-x86_64-\d{8}-git-[0-9a-f]+\.7z$/;
const MIN_LIBMPV_DLL_BYTES = 80 * 1024 * 1024;

// 7-Zip standalone console extractor used to unpack both archives. It is a
// rolling download (no per-version URL), so it is pinned by SHA-256 and size
// here and verified before first execution. Measured 2026-10-29 from
// https://www.7-zip.org/a/7zr.exe -> "7-Zip (r) 26.04 (x86)". If 7-zip.org
// publishes a new r-build this mismatch makes the script fail loudly instead of
// executing an unverified binary: re-download, re-measure, update both values.
const SEVENZIP_URL = "https://www.7-zip.org/a/7zr.exe";
const SEVENZIP_SHA256 =
  "256feca8e274e5da655e2a284fabafd9f554365eb164862089dacd4e8276d282";
const SEVENZIP_BYTES = 602624;
// ---------------------------------------------------------------------------

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
const workDir = join(tmpdir(), "drplay-mpv-fetch");

const TOOLS_DIR = join(tmpdir(), "drplay-mpv-tools");

const ARTIFACTS = {
  libmpv: {
    key: "libmpv",
    label: "libmpv DLL",
    path: join(repoRoot, LIBMPV_DLL_RELPATH),
    pattern: LIBMPV_ASSET_PATTERN,
    sha256: LIBMPV_ASSET_SHA256,
    minBytes: MIN_LIBMPV_DLL_BYTES,
    member: "libmpv-2.dll",
    digestRequired: "always",
  },
  sidecar: {
    key: "sidecar",
    label: "mpv sidecar",
    path: join(repoRoot, SIDECAR_RELPATH),
    pattern: MPV_ASSET_PATTERN,
    sha256: MPV_ASSET_SHA256,
    minBytes: MIN_MPV_EXE_BYTES,
    member: "mpv.exe",
    digestRequired: "fallback-only",
  },
};

const MODE_FLAGS = new Set([
  "--force",
  "--with-sidecar",
  "--sidecar",
  "--libmpv-only",
]);

class Abort extends Error {}

function fail(stage, error) {
  console.error(`[fetch-mpv] ${stage} failed: ${error}`);
  throw new Abort();
}

function sha256Of(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
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
  const sha = sha256Of(archivePath);
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

// Resolves the pinned tag, falling back to `latest` (loud warning) when the pin
// has been pruned upstream. The fallback still requires a GitHub asset digest.
function resolveRelease() {
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
  if (fellBackToLatest) {
    console.warn(
      `[fetch-mpv] WARNING: pinned tag ${requestedTag} no longer exists upstream (pruned).`,
    );
    console.warn(
      `[fetch-mpv] WARNING: falling back to latest ${release.tag_name}; re-pin MPV_WINBUILD_TAG + the asset SHA-256 values to keep builds reproducible.`,
    );
  }
  return release;
}

function findAsset(release, artifact) {
  const asset = release.assets.find((candidate) =>
    artifact.pattern.test(candidate.name),
  );
  if (!asset) {
    fail(
      "release lookup",
      `no ${artifact.pattern} asset in release ${release.tag_name} (releases url ${MPV_WINBUILD_RELEASES_URL})`,
    );
  }
  const needsDigest =
    artifact.digestRequired === "always" ||
    release.tag_name !== MPV_WINBUILD_TAG;
  if (needsDigest && !asset.digest) {
    fail(
      "download",
      `release ${release.tag_name} has no asset digest for ${asset.name}; refusing unverified archive (url ${asset.browser_download_url})`,
    );
  }
  return asset;
}

// Downloads the pinned 7-Zip console extractor and verifies it before any
// execution. Cached in a temp tools dir across runs, re-verified on every use.
function ensureSevenZip() {
  mkdirSync(TOOLS_DIR, { recursive: true });
  const sevenZipPath = join(TOOLS_DIR, "7zr.exe");
  if (
    existsSync(sevenZipPath) &&
    statSync(sevenZipPath).size === SEVENZIP_BYTES
  ) {
    const cachedSha = sha256Of(sevenZipPath);
    if (cachedSha === SEVENZIP_SHA256) return sevenZipPath;
    rmSync(sevenZipPath, { force: true });
  } else if (existsSync(sevenZipPath)) {
    rmSync(sevenZipPath, { force: true });
  }
  curl(SEVENZIP_URL, sevenZipPath, HTTP_TIMEOUT_SECS);
  const bytes = statSync(sevenZipPath).size;
  if (bytes !== SEVENZIP_BYTES) {
    fail(
      "7zr verify",
      `${SEVENZIP_URL}: size mismatch got ${bytes} bytes, expected ${SEVENZIP_BYTES}`,
    );
  }
  const sha = sha256Of(sevenZipPath);
  if (sha !== SEVENZIP_SHA256) {
    fail(
      "7zr verify",
      `${SEVENZIP_URL}: sha256 mismatch got ${sha}, expected ${SEVENZIP_SHA256}. ` +
        "7-zip.org may have published a new build; re-measure and update " +
        "SEVENZIP_SHA256 + SEVENZIP_BYTES in the METADATA block.",
    );
  }
  console.log(`[fetch-mpv] 7zr verified: sha256 ${sha} (${bytes} bytes)`);
  return sevenZipPath;
}

function extractMember(sevenZipPath, archivePath, member, outDir) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const result = spawnSync(
    sevenZipPath,
    ["e", archivePath, "-o" + outDir, member, "-y"],
    {
      timeout: 10 * 60 * 1000,
    },
  );
  if (result.error) fail("extract", `7zr.exe: ${result.error.message}`);
  if (result.status !== 0)
    fail(
      "extract",
      `7zr.exe exited ${result.status} extracting ${member} from ${archivePath}: ${result.stderr}`,
    );
  const extractedPath = join(outDir, member);
  if (!existsSync(extractedPath))
    fail("extract", `${member} missing from ${archivePath}`);
  return extractedPath;
}

function installArtifact(artifact, release, sevenZipPath) {
  const asset = findAsset(release, artifact);
  console.log(
    `[fetch-mpv] ${artifact.label}: release ${release.tag_name} -> ${asset.name} (${Math.round(asset.size / 1048576)}MB)`,
  );

  const { archivePath, sha } = downloadVerified(asset);
  if (release.tag_name === MPV_WINBUILD_TAG && sha !== artifact.sha256) {
    fail(
      "download",
      `SHA-256 mismatch for ${asset.name}: got ${sha}, expected ${artifact.sha256} (tag ${release.tag_name}, url ${asset.browser_download_url})`,
    );
  }
  console.log(`[fetch-mpv] ${artifact.label} archive verified: sha256 ${sha}`);

  const extractedPath = extractMember(
    sevenZipPath,
    archivePath,
    artifact.member,
    join(workDir, "out", artifact.key),
  );
  const extractedBytes = statSync(extractedPath).size;
  if (extractedBytes < artifact.minBytes) {
    fail(
      "extract",
      `${artifact.member} suspiciously small (${extractedBytes} bytes, expected at least ${artifact.minBytes})`,
    );
  }
  mkdirSync(dirname(artifact.path), { recursive: true });
  copyFileSync(extractedPath, artifact.path);
  console.log(
    `[fetch-mpv] ${artifact.label}: ${artifact.path} (${Math.round(statSync(artifact.path).size / 1048576)}MB)`,
  );
}

function parseMode(argv) {
  for (const arg of argv.filter((value) => value.startsWith("--"))) {
    if (!MODE_FLAGS.has(arg))
      fail(
        "args",
        `unknown flag ${arg}; usage: node scripts/fetch-mpv.mjs [--libmpv-only | --with-sidecar] [--force]`,
      );
  }
  const wantsSidecar =
    argv.includes("--with-sidecar") || argv.includes("--sidecar");
  if (wantsSidecar && argv.includes("--libmpv-only")) {
    fail("args", "--with-sidecar and --libmpv-only are mutually exclusive");
  }
  return wantsSidecar ? "both" : "libmpv";
}

function main() {
  if (process.platform !== "win32") {
    fail(
      "platform",
      "this script downloads a Windows mpv build; run it on Windows",
    );
  }

  const force = process.argv.includes("--force");
  const mode = parseMode(process.argv.slice(2));
  const selected =
    mode === "both"
      ? [ARTIFACTS.libmpv, ARTIFACTS.sidecar]
      : [ARTIFACTS.libmpv];
  const modeLabel = selected.map((artifact) => artifact.label).join(" + ");
  console.log(`[fetch-mpv] mode: ${mode} (${modeLabel})`);

  const pending = [];
  for (const artifact of selected) {
    if (!existsSync(artifact.path)) {
      pending.push(artifact);
      continue;
    }
    if (force) {
      pending.push(artifact);
      continue;
    }
    const bytes = statSync(artifact.path).size;
    if (bytes < artifact.minBytes) {
      fail(
        "verify",
        `${artifact.label} present at ${artifact.path} but only ${bytes} bytes (expected at least ${artifact.minBytes}); delete it or run --force to re-download`,
      );
    }
    console.log(
      `[fetch-mpv] ${artifact.label} already present: ${artifact.path}`,
    );
  }

  if (pending.length === 0) {
    console.log(
      `[fetch-mpv] ${modeLabel} up to date (use --force to re-download)`,
    );
    return;
  }

  mkdirSync(workDir, { recursive: true });
  const sevenZipPath = ensureSevenZip();
  const release = resolveRelease();
  for (const artifact of pending) {
    installArtifact(artifact, release, sevenZipPath);
  }
  console.log(`[fetch-mpv] done (${pending.map((a) => a.label).join(", ")})`);
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
