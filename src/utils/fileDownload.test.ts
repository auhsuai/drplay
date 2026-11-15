// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { TFunction } from "i18next";
import {
  classifyDownloadError,
  downloadErrorMessage,
  fetchDriveFileMetadata,
  fetchMetadataBestEffort,
  toDownloadProgressState,
  type FileDownloadProgressEvent,
} from "./fileDownload";
import { fetchWithAuth } from "./apiClient";

vi.mock("./apiClient", () => ({
  fetchWithAuth: vi.fn(),
}));

const mockedFetchWithAuth = vi.mocked(fetchWithAuth);

// Minimal TFunction backed by the key itself: the message mapping is
// asserted by key, not by copy (copy lives in the locale files).
const t = ((key: string) => key) as unknown as TFunction;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("classifyDownloadError", () => {
  it.each([
    ["network: a network error occurred", "network"],
    ["http_status: the server answered with HTTP 500", "network"],
    ["idle_timeout: the download stalled", "timeout"],
    ["file_missing: the file is no longer available", "not_found"],
    ["forbidden: this account may not download", "forbidden"],
    ["rate_limited: Google Drive is rate limiting", "rate_limited"],
    ["unauthorized: the Google sign-in expired", "unauthorized"],
    ["auth_refresh: refreshing the Google sign-in failed", "unauthorized"],
    ["insufficient_space: not enough free space", "no_space"],
    ["checksum_mismatch: the download does not match", "checksum"],
    ["size_mismatch: the downloaded size differs", "size"],
    ["io: writing the download failed", "save"],
    ["publish_failed: the finished file could not be moved", "save"],
    ["cancelled: the download was cancelled", "cancelled"],
    [
      "already_in_progress: a download is already running",
      "already_in_progress",
    ],
    [
      "already_exists: a file already exists at the destination",
      "already_exists",
    ],
    ["something entirely different", "unknown"],
    ["", "unknown"],
  ] as const)("maps %j to %j", (message, expected) => {
    expect(classifyDownloadError(message)).toBe(expected);
  });

  it("accepts an Error object", () => {
    expect(classifyDownloadError(new Error("file_missing: gone"))).toBe(
      "not_found",
    );
  });
});

describe("downloadErrorMessage", () => {
  it.each([
    ["network", "menu.download_failed_network"],
    ["timeout", "menu.download_failed_timeout"],
    ["not_found", "menu.download_failed_not_found"],
    ["forbidden", "menu.download_failed_forbidden"],
    ["rate_limited", "menu.download_failed_rate_limited"],
    ["unauthorized", "menu.download_failed_token"],
    ["no_space", "menu.download_failed_no_space"],
    ["checksum", "menu.download_failed_checksum"],
    ["size", "menu.download_failed_size"],
    ["save", "menu.download_failed_save"],
    ["already_exists", "menu.download_failed_exists"],
    ["unknown", "menu.download_failed"],
  ] as const)("kind %j renders key %j", (kind, key) => {
    expect(downloadErrorMessage(kind, t)).toBe(key);
  });

  it("cancelled is silent (no message)", () => {
    expect(downloadErrorMessage("cancelled", t)).toBeNull();
  });
});

describe("toDownloadProgressState", () => {
  it("passes downloading events through, deriving nothing new", () => {
    const event: FileDownloadProgressEvent = {
      stage: "downloading",
      downloadId: "d1",
      downloaded: 50,
      total: 100,
      percent: 50,
      speedBytesPerSec: 1024,
      paused: false,
    };
    expect(toDownloadProgressState(event)).toEqual({
      downloaded: 50,
      total: 100,
      percent: 50,
      speedBytesPerSec: 1024,
      stage: "downloading",
      paused: false,
    });
  });

  it("derives the percent for the verifying stage from downloaded/total", () => {
    const event: FileDownloadProgressEvent = {
      stage: "verifying",
      downloadId: "d1",
      downloaded: 100,
      total: 100,
    };
    const state = toDownloadProgressState(event);
    expect(state.stage).toBe("verifying");
    expect(state.percent).toBe(100);
    expect(state.paused).toBe(false);
  });

  it("leaves percent undefined when the verifying total is unknown", () => {
    const event: FileDownloadProgressEvent = {
      stage: "verifying",
      downloadId: "d1",
      downloaded: 42,
    };
    expect(toDownloadProgressState(event).percent).toBeUndefined();
  });
});

describe("fetchDriveFileMetadata", () => {
  it("parses size as a number and keeps the md5", async () => {
    mockedFetchWithAuth.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ size: "12345", md5Checksum: "abc123" }),
    } as unknown as Response);

    const meta = await fetchDriveFileMetadata("file-1");
    expect(meta).toEqual({
      size: 12345,
      md5Checksum: "abc123",
      mimeType: undefined,
      canDownload: undefined,
    });
    expect(mockedFetchWithAuth).toHaveBeenCalledWith(
      expect.stringContaining(
        "files/file-1?fields=size,md5Checksum,mimeType,capabilities/canDownload",
      ),
      expect.anything(),
    );
  });

  it("parses mimeType and canDownload when Drive sends them", async () => {
    mockedFetchWithAuth.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          size: "99",
          mimeType: "application/pdf",
          capabilities: { canDownload: false },
        }),
    } as unknown as Response);

    const meta = await fetchDriveFileMetadata("file-1");
    expect(meta).toEqual({
      size: 99,
      md5Checksum: undefined,
      mimeType: "application/pdf",
      canDownload: false,
    });
  });

  it("tolerates a file without an md5 (Docs native, folders)", async () => {
    mockedFetchWithAuth.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ size: "10" }),
    } as unknown as Response);

    const meta = await fetchDriveFileMetadata("file-1");
    expect(meta).toEqual({
      size: 10,
      md5Checksum: undefined,
      mimeType: undefined,
      canDownload: undefined,
    });
  });

  it("throws with the status on a non-OK response", async () => {
    mockedFetchWithAuth.mockResolvedValue({
      ok: false,
      status: 404,
    } as unknown as Response);

    await expect(fetchDriveFileMetadata("file-1")).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("fetchMetadataBestEffort", () => {
  it("reports fileGone on 404 and does not throw", async () => {
    mockedFetchWithAuth.mockResolvedValue({
      ok: false,
      status: 404,
    } as unknown as Response);

    await expect(fetchMetadataBestEffort("file-1")).resolves.toEqual({
      metadata: {},
      fileGone: true,
    });
  });

  it("degrades to empty metadata on a transient failure", async () => {
    mockedFetchWithAuth.mockRejectedValue(new Error("network down"));

    await expect(fetchMetadataBestEffort("file-1")).resolves.toEqual({
      metadata: {},
      fileGone: false,
    });
  });
});
