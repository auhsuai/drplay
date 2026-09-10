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
// Mock the SW wire so the seed call is observed without a real worker.
vi.mock("../utils/swPrefetch", () => ({
  prefetchTrackInServiceWorker: vi.fn(),
  rememberTotalSizesInServiceWorker: vi.fn(),
}));
import { fetchWithAuth } from "../utils/apiClient";
import { rememberTotalSizesInServiceWorker } from "../utils/swPrefetch";
const mockedFetch = vi.mocked(fetchWithAuth);
const mockedRemember = vi.mocked(rememberTotalSizesInServiceWorker);

const FOLDER_ID = "folder-under-test";

function makeDriveFile(page: number, idx: number) {
  return {
    id: `p${String(page)}-f${String(idx)}`,
    name: `track-p${String(page)}-${String(idx)}.mp3`,
    mimeType: "audio/mpeg",
    parents: [FOLDER_ID],
    size: "1000",
    modifiedTime: "2024-01-01T00:00:00.000Z",
  };
}

function makePage(
  files: Array<Record<string, unknown>>,
  nextPageToken?: string,
) {
  return {
    ok: true,
    json: () => ({ files, nextPageToken }),
  } as unknown as Response;
}

describe("useDriveExplorer fetchOnDemand (incremental DB writes)", () => {
  beforeEach(async () => {
    await db.files.clear();
    useDriveStore.setState({ isLoadingTracks: false });
    mockedFetch.mockReset();
    mockedRemember.mockClear();
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

  it("dispatches drive-files-changed after each written page (count = page rows)", async () => {
    // Literal matches the HomeTab listener tests' existing pattern (this file
    // asserts the wire contract, not the constant's home module).
    const EVENT = "drive-files-changed";

    mockedFetch
      .mockResolvedValueOnce(
        makePage(
          [0, 1, 2, 3, 4].map((i) => makeDriveFile(1, i)),
          "token-2",
        ),
      )
      .mockResolvedValueOnce(makePage([0, 1].map((i) => makeDriveFile(2, i))));

    const events: CustomEvent[] = [];
    const listener = (e: Event): void => {
      events.push(e as CustomEvent);
    };
    window.addEventListener(EVENT, listener);

    try {
      renderHook(() =>
        useDriveExplorer(FOLDER_ID, "Folder", "fake-token", () => {}),
      );

      await waitFor(async () => {
        const count = await db.files
          .where("parentId")
          .equals(FOLDER_ID)
          .count();
        expect(count).toBe(7);
      });

      // The dispatch is synchronous immediately after each page's bulkPut
      // resolves, so by the time the DB shows all rows both events have fired.
      // One event per written page; detail.count = that page's row count.
      expect(events.length).toBe(2);
      expect(events[0]?.detail).toEqual({ count: 5 });
      expect(events[1]?.detail).toEqual({ count: 2 });
    } finally {
      window.removeEventListener(EVENT, listener);
    }
  });

  it("does not dispatch drive-files-changed for an empty page", async () => {
    const EVENT = "drive-files-changed";
    mockedFetch.mockResolvedValueOnce(makePage([]));

    const listener = vi.fn();
    window.addEventListener(EVENT, listener);

    try {
      renderHook(() =>
        useDriveExplorer(FOLDER_ID, "Folder", "fake-token", () => {}),
      );

      // Let the no-op page resolve and the loop finish.
      await new Promise((r) => setTimeout(r, 20));

      expect(await db.files.where("parentId").equals(FOLDER_ID).count()).toBe(
        0,
      );
      expect(listener).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(EVENT, listener);
    }
  });

  it("does not dispatch drive-files-changed when the Dexie write fails", async () => {
    const EVENT = "drive-files-changed";
    mockedFetch.mockResolvedValueOnce(
      makePage([0, 1].map((i) => makeDriveFile(1, i))),
    );

    const bulkPutSpy = vi
      .spyOn(db.files, "bulkPut")
      .mockRejectedValueOnce(new Error("QuotaExceededError"));
    const listener = vi.fn();
    window.addEventListener(EVENT, listener);

    try {
      renderHook(() =>
        useDriveExplorer(FOLDER_ID, "Folder", "fake-token", () => {}),
      );

      await waitFor(() => {
        expect(bulkPutSpy).toHaveBeenCalledTimes(1);
      });
      await new Promise((r) => setTimeout(r, 20));

      expect(listener).not.toHaveBeenCalled();
      expect(await db.files.where("parentId").equals(FOLDER_ID).count()).toBe(
        0,
      );
    } finally {
      window.removeEventListener(EVENT, listener);
      bulkPutSpy.mockRestore();
    }
  });

  it("seeds SW total sizes from each persisted page (folders and sizeless rows excluded)", async () => {
    mockedFetch.mockResolvedValueOnce(
      makePage([
        ...[0, 1, 2].map((i) => makeDriveFile(1, i)),
        {
          id: "p1-fold",
          name: "subfolder",
          mimeType: "application/vnd.google-apps.folder",
          parents: [FOLDER_ID],
        },
      ]),
    );

    renderHook(() =>
      useDriveExplorer(FOLDER_ID, "Folder", "fake-token", () => {}),
    );

    // Fires only after the page's Dexie write resolved: rows are visible AND
    // the seed message carries exactly the parsed sizes of that page.
    await waitFor(async () => {
      const count = await db.files.where("parentId").equals(FOLDER_ID).count();
      expect(count).toBe(4);
    });
    expect(mockedRemember).toHaveBeenCalledTimes(1);
    expect(mockedRemember).toHaveBeenCalledWith([
      { fileId: "p1-f0", size: 1000 },
      { fileId: "p1-f1", size: 1000 },
      { fileId: "p1-f2", size: 1000 },
    ]);
  });

  it("does not seed SW sizes when the Dexie write fails", async () => {
    mockedFetch.mockResolvedValueOnce(
      makePage([0, 1].map((i) => makeDriveFile(1, i))),
    );

    const bulkPutSpy = vi
      .spyOn(db.files, "bulkPut")
      .mockRejectedValueOnce(new Error("QuotaExceededError"));

    renderHook(() =>
      useDriveExplorer(FOLDER_ID, "Folder", "fake-token", () => {}),
    );

    await waitFor(() => {
      expect(bulkPutSpy).toHaveBeenCalledTimes(1);
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(mockedRemember).not.toHaveBeenCalled();
    bulkPutSpy.mockRestore();
  });
});
