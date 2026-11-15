import type { TFunction } from "i18next";
import { fetchWithAuth } from "./apiClient";
import { DRIVE_FILES_URL } from "./driveFiles";
import { captureError } from "./errorLog";

// Frontend edge of the Rust streaming download (`src-tauri/src/file_download.rs`).
// The Rust command owns the network, the `.part` file, resume and verification;
// this module only fetches the file metadata the command needs (size +
// md5Checksum, which `Track` does not carry) and translates the command's
// stable `"<code>: <message>"` error strings into localised UI copy.

/// Progress event payload from the Rust `Channel`, mirroring
/// `FileDownloadProgress` in `file_download.rs`.
export type FileDownloadProgressEvent =
  | {
      stage: "downloading";
      downloadId: string;
      downloaded: number;
      total?: number | undefined;
      percent?: number | undefined;
      speedBytesPerSec?: number | undefined;
      paused: boolean;
    }
  | {
      stage: "verifying";
      downloadId: string;
      downloaded: number;
      total?: number | undefined;
    };

/// The progress state the download dialog renders.
export type DownloadProgressState = {
  downloaded: number;
  total?: number | undefined;
  percent?: number | undefined;
  speedBytesPerSec?: number | undefined;
  stage: "downloading" | "verifying";
  paused: boolean;
};

export function toDownloadProgressState(
  event: FileDownloadProgressEvent,
): DownloadProgressState {
  if (event.stage === "verifying") {
    return {
      downloaded: event.downloaded,
      total: event.total,
      percent:
        event.total !== undefined && event.total > 0
          ? Math.min(100, Math.floor((event.downloaded * 100) / event.total))
          : undefined,
      speedBytesPerSec: undefined,
      stage: "verifying",
      paused: false,
    };
  }
  return {
    downloaded: event.downloaded,
    total: event.total,
    percent: event.percent,
    speedBytesPerSec: event.speedBytesPerSec,
    stage: "downloading",
    paused: event.paused,
  };
}

export type DriveFileMetadata = {
  size?: number | undefined;
  md5Checksum?: string | undefined;
};

export class FileMetadataError extends Error {
  readonly status?: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "FileMetadataError";
    this.status = status;
  }
}

/// Fetches `size` + `md5Checksum` for one Drive file. The size feeds the
/// pre-flight free-space check and the progress total; the MD5 feeds the
/// Rust verification gate. Throws `FileMetadataError` (with `.status`) on a
/// non-OK response so the caller can tell "file gone" (404/410) from a
/// transient failure.
export async function fetchDriveFileMetadata(
  fileId: string,
  signal?: AbortSignal,
): Promise<DriveFileMetadata> {
  const url = `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?fields=size,md5Checksum`;
  const response = await fetchWithAuth(url, signal ? { signal } : {});
  if (!response.ok) {
    throw new FileMetadataError(
      `Failed to read file metadata (${String(response.status)})`,
      response.status,
    );
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new FileMetadataError(
      "Failed to read file metadata (invalid response)",
    );
  }
  if (typeof data !== "object" || data === null) {
    throw new FileMetadataError(
      "Failed to read file metadata (invalid response)",
    );
  }
  const item = data as { size?: unknown; md5Checksum?: unknown };
  const size =
    typeof item.size === "string" && item.size !== ""
      ? Number.parseInt(item.size, 10)
      : undefined;
  return {
    size: size !== undefined && Number.isFinite(size) ? size : undefined,
    md5Checksum:
      typeof item.md5Checksum === "string" && item.md5Checksum !== ""
        ? item.md5Checksum
        : undefined,
  };
}

/// Stable error kinds, derived from the `<code>` prefix of the Rust error
/// string. Unknown codes fall through to "unknown" (generic message) rather
/// than crashing the toast.
export type DownloadErrorKind =
  | "network"
  | "timeout"
  | "not_found"
  | "forbidden"
  | "rate_limited"
  | "unauthorized"
  | "no_space"
  | "checksum"
  | "size"
  | "save"
  | "cancelled"
  | "already_in_progress"
  | "unknown";

export function classifyDownloadError(message: unknown): DownloadErrorKind {
  const text =
    message instanceof Error
      ? message.message
      : typeof message === "string"
        ? message
        : "";
  const code = text.split(":")[0]?.trim() ?? "";
  switch (code) {
    case "network":
    case "http_status":
      return "network";
    case "io":
    case "publish_failed":
      // Local write/publish failure (incl. disk full mid-write): the bytes
      // arrived, the disk did not take them.
      return "save";
    case "idle_timeout":
      return "timeout";
    case "file_missing":
      return "not_found";
    case "forbidden":
      return "forbidden";
    case "rate_limited":
      return "rate_limited";
    case "unauthorized":
    case "auth_refresh":
      return "unauthorized";
    case "insufficient_space":
      return "no_space";
    case "checksum_mismatch":
      return "checksum";
    case "size_mismatch":
      return "size";
    case "cancelled":
      return "cancelled";
    case "already_in_progress":
      return "already_in_progress";
    default:
      return "unknown";
  }
}

/// Localised message for a download failure kind. `cancelled` has no message
/// (a user-initiated cancel is silent by design) and returns `null`.
export function downloadErrorMessage(
  kind: DownloadErrorKind,
  t: TFunction,
): string | null {
  switch (kind) {
    case "network":
      return t("menu.download_failed_network");
    case "timeout":
      return t("menu.download_failed_timeout");
    case "not_found":
      return t("menu.download_failed_not_found");
    case "forbidden":
      return t("menu.download_failed_forbidden");
    case "rate_limited":
      return t("menu.download_failed_rate_limited");
    case "unauthorized":
      return t("menu.download_failed_token");
    case "no_space":
      return t("menu.download_failed_no_space");
    case "checksum":
      return t("menu.download_failed_checksum");
    case "size":
      return t("menu.download_failed_size");
    case "save":
      return t("menu.download_failed_save");
    case "already_in_progress":
      return t("menu.download_failed");
    case "cancelled":
      return null;
    case "unknown":
    default:
      return t("menu.download_failed");
  }
}

/** Best-effort metadata read: a metadata failure must not block a download
 * whose token is fine — the Rust command falls back to the server's
 * Content-Length. Only a 404/410 (file gone) is fatal, and it is reported
 * as such instead of being swallowed. */
export async function fetchMetadataBestEffort(
  fileId: string,
  signal?: AbortSignal,
): Promise<{ metadata: DriveFileMetadata; fileGone: boolean }> {
  try {
    const metadata = await fetchDriveFileMetadata(fileId, signal);
    return { metadata, fileGone: false };
  } catch (err: unknown) {
    const status = err instanceof FileMetadataError ? err.status : undefined;
    if (status === 404 || status === 410) {
      return { metadata: {}, fileGone: true };
    }
    void captureError({
      level: "warn",
      source: "fileDownload",
      message: `Download metadata read failed, continuing without size/md5: ${String(err)}`,
    });
    return { metadata: {}, fileGone: false };
  }
}
