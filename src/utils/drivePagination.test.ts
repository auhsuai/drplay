import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  searchFolders,
  listFolderChildren,
  getTrashedFiles,
} from "./drivePagination";
import type { DriveFolderItem, DriveFileItem } from "./driveApi";

vi.mock("./apiClient", () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock("./errorLog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./errorLog")>();
  return {
    ...actual,
    captureError: vi.fn(),
  };
});

import { fetchWithAuth } from "./apiClient";
import { captureError } from "./errorLog";

const mockedFetch = vi.mocked(fetchWithAuth);
const mockedCapture = vi.mocked(captureError);

function makeJsonResponse(status: number, body: unknown): Response {
  const ok = status >= 200 && status < 300;
  return {
    status,
    ok,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const folder = (id: string, name: string): DriveFolderItem => ({
  id,
  name,
  mimeType: "application/vnd.google-apps.folder",
});

const makeFolders = (count: number, prefix: string): DriveFolderItem[] =>
  Array.from({ length: count }, (_, i) =>
    folder(`${prefix}${String(i)}`, `${prefix}${String(i)}`),
  );

function capturePages(
  pages: Array<{ files: DriveFolderItem[]; nextPageToken?: string }>,
): void {
  let n = 0;
  mockedFetch.mockImplementation(() => {
    const page = pages[n];
    n += 1;
    return Promise.resolve(makeJsonResponse(200, page));
  });
}

describe("drivePagination silent-truncate warn", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    mockedCapture.mockClear();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("warns exactly once when hitting the page cap with a leftover token", async () => {
    const pages = Array.from({ length: 12 }, () => ({
      files: makeFolders(30, "cap"),
      nextPageToken: "next-secret-token",
    }));
    capturePages(pages);

    const result = await searchFolders("tok", "name contains 'x'");

    expect(mockedFetch).toHaveBeenCalledTimes(10);
    expect(result).toHaveLength(300);
    expect(mockedCapture).toHaveBeenCalledTimes(1);
    const arg = mockedCapture.mock.calls[0]?.[0];
    expect(arg).toEqual(
      expect.objectContaining({ level: "warn", source: "drivePagination" }),
    );
    // Context without PII/token leakage.
    expect(String(arg?.message)).toContain("10");
    expect(String(arg?.message)).not.toContain("next-secret-token");
  });

  it("does not warn when the token is exhausted before the cap", async () => {
    capturePages([
      { files: makeFolders(30, "a"), nextPageToken: "tok2" },
      { files: makeFolders(5, "b") },
    ]);

    const result = await searchFolders("tok", "name contains 'x'");

    expect(result).toHaveLength(35);
    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(mockedCapture).not.toHaveBeenCalled();
  });

  it("does not warn for a single page under the cap", async () => {
    capturePages([{ files: makeFolders(3, "z") }]);

    const result = await listFolderChildren("tok", "folderId");

    expect(result).toHaveLength(3);
    expect(mockedCapture).not.toHaveBeenCalled();
  });

  it("abort between pages keeps old behavior (no warn, accumulated pages)", async () => {
    const controller = new AbortController();
    mockedFetch.mockImplementation(() => {
      if (!controller.signal.aborted) controller.abort();
      return Promise.resolve(
        makeJsonResponse(200, {
          files: makeFolders(30, "brk"),
          nextPageToken: "tok2",
        }),
      );
    });

    const result = await searchFolders(
      "tok",
      "name contains 'x'",
      controller.signal,
    );

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(30);
    expect(mockedCapture).not.toHaveBeenCalled();
  });

  it("getTrashedFiles warns once at the cap (shared paginator contract)", async () => {
    type TrashPage = { files: DriveFileItem[]; nextPageToken?: string };
    const trashed = (id: string): DriveFileItem => ({
      id,
      name: id,
      mimeType: "audio/mpeg",
    });
    const pages: TrashPage[] = Array.from({ length: 11 }, () => ({
      files: Array.from({ length: 30 }, (_, i) => trashed(`t${String(i)}`)),
      nextPageToken: "next-secret-token",
    }));
    let n = 0;
    mockedFetch.mockImplementation(() => {
      const page = pages[n];
      n += 1;
      return Promise.resolve(makeJsonResponse(200, page));
    });

    const result = await getTrashedFiles("tok", "trashed=true");

    expect(mockedFetch).toHaveBeenCalledTimes(10);
    expect(result).toHaveLength(300);
    expect(mockedCapture).toHaveBeenCalledTimes(1);
  });
});
