// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { db } from "../db/db";
import { useDriveExplorer } from "./useDriveExplorer";
import { useDriveStore } from "../store/driveStore";

// Mock network layer only; keep real Dexie (fake-indexeddb) to assert DB writes.
vi.mock("../utils/apiClient", () => ({
  fetchWithAuth: vi.fn(),
}));
import { fetchWithAuth } from "../utils/apiClient";
const mockedFetch = vi.mocked(fetchWithAuth);

const FOLDER_ID = "folder-under-test";

function makeDriveFile(page: number, idx: number) {
  return {
    id: `p${page}-f${idx}`,
    name: `track-p${page}-${idx}.mp3`,
    mimeType: "audio/mpeg",
    parents: [FOLDER_ID],
    size: "1000",
    modifiedTime: "2024-01-01T00:00:00.000Z",
  };
}

function makePage(files: any[], nextPageToken?: string) {
  return {
    ok: true,
    json: async () => ({ files, nextPageToken }),
  } as unknown as Response;
}

describe("useDriveExplorer fetchOnDemand (incremental DB writes)", () => {
  beforeEach(async () => {
    await db.files.clear();
    useDriveStore.setState({ isLoadingTracks: false });
    mockedFetch.mockReset();
  });

  afterEach(async () => {
    await db.files.clear();
  });

  it("writes each fetched page to Dexie immediately (bulkPut per page), not one accumulated write", async () => {
    // 3 pages x 5 files each
    mockedFetch
      .mockResolvedValueOnce(
        makePage(
          [0, 1, 2, 3, 4].map((i) => makeDriveFile(1, i)),
          "token-2",
        ),
      )
      .mockResolvedValueOnce(
        makePage(
          [0, 1, 2, 3, 4].map((i) => makeDriveFile(2, i)),
          "token-3",
        ),
      )
      .mockResolvedValueOnce(
        makePage([0, 1, 2, 3, 4].map((i) => makeDriveFile(3, i))),
      );

    const bulkPutSpy = vi.spyOn(db.files, "bulkPut");

    renderHook(() =>
      useDriveExplorer(FOLDER_ID, "Folder", "fake-token", () => {}),
    );

    await waitFor(async () => {
      const count = await db.files.where("parentId").equals(FOLDER_ID).count();
      expect(count).toBe(15);
    });

    // Regression assertion: old code accumulated all pages into one array and
    // called bulkPut exactly ONCE after the loop. Correct behavior writes
    // per-page, so bulkPut must be called once per fetched page (3 times).
    expect(bulkPutSpy.mock.calls.length).toBe(3);

    // Each call must carry only that page's files (5), not an accumulated superset.
    for (const call of bulkPutSpy.mock.calls) {
      expect(call[0]).toHaveLength(5);
    }

    bulkPutSpy.mockRestore();
  });

  it("still writes earlier pages when a later page request fails", async () => {
    mockedFetch
      .mockResolvedValueOnce(
        makePage(
          [0, 1].map((i) => makeDriveFile(1, i)),
          "token-2",
        ),
      )
      // 404 is non-retryable for driveFetch — the fetch breaks immediately.
      // (500 would now be retried up to 4x with real-time exponential backoff,
      // which would stall the test.)
      .mockResolvedValueOnce({ ok: false, status: 404 } as unknown as Response);

    renderHook(() =>
      useDriveExplorer(FOLDER_ID, "Folder", "fake-token", () => {}),
    );

    await waitFor(async () => {
      const count = await db.files.where("parentId").equals(FOLDER_ID).count();
      expect(count).toBe(2);
    });
  });

  it("retries a 429 rate-limit response (Retry-After) and continues pagination", async () => {
    // driveFetch (driveApi) owns the retry policy now: 429 is retryable.
    // Retry-After: 0 keeps the test off real-time backoff sleeps while still
    // proving the retry path (Google handle-errors guidance).
    mockedFetch
      .mockResolvedValueOnce(
        makePage(
          [0, 1].map((i) => makeDriveFile(1, i)),
          "token-2",
        ),
      )
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: {
          get: (name: string) => (name === "Retry-After" ? "0" : null),
        },
      } as unknown as Response)
      .mockResolvedValueOnce(makePage([0, 1].map((i) => makeDriveFile(2, i))));

    renderHook(() =>
      useDriveExplorer(FOLDER_ID, "Folder", "fake-token", () => {}),
    );

    await waitFor(async () => {
      const count = await db.files.where("parentId").equals(FOLDER_ID).count();
      expect(count).toBe(4);
    });

    // page 1 + 429 attempt + retried page 2
    expect(mockedFetch).toHaveBeenCalledTimes(3);
  });

  it("does not write anything when the component unmounts before first page resolves", async () => {
    let resolveFirst: (v: Response) => void = () => {};
    mockedFetch.mockImplementationOnce(
      () =>
        new Promise<Response>((res) => {
          resolveFirst = res;
        }),
    );

    const { unmount } = renderHook(() =>
      useDriveExplorer(FOLDER_ID, "Folder", "fake-token", () => {}),
    );

    // Unmount before the first page arrives.
    unmount();
    resolveFirst(makePage([0, 1].map((i) => makeDriveFile(1, i))));

    // Give the microtask queue a chance to flush.
    await new Promise((r) => setTimeout(r, 20));

    const count = await db.files.where("parentId").equals(FOLDER_ID).count();
    expect(count).toBe(0);
  });
});
