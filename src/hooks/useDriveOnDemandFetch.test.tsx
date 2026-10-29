// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { db } from "../db/db";
import { useDriveStore } from "../store/driveStore";
import { ROOT_FOLDER_ID, VIRTUAL_ROOT_ID } from "../utils/driveConstants";
import { FOLDER_MIME } from "../utils/driveApi";
import { DEFAULT_USER_EMAIL } from "../utils/storageKeys";
import { captureError } from "../utils/errorLog";
import { useDriveOnDemandFetch } from "./useDriveOnDemandFetch";

// Mock the network layer only; keep real Dexie (fake-indexeddb) so any Dexie
// access would be observable.
vi.mock("../utils/apiClient", () => ({
  fetchWithAuth: vi.fn(),
}));
vi.mock("../utils/errorLog", () => ({ captureError: vi.fn() }));
import { fetchWithAuth } from "../utils/apiClient";
const mockedFetch = vi.mocked(fetchWithAuth);
const mockedCaptureError = vi.mocked(captureError);

function emptyPage(): Response {
  return {
    ok: true,
    json: () => ({ files: [] }),
  } as unknown as Response;
}

function cachedRow(id: string, isFolder: boolean) {
  return {
    id,
    name: id,
    mimeType: isFolder ? FOLDER_MIME : "audio/mpeg",
    parentId: ROOT_FOLDER_ID,
    trashed: false,
    isFolder,
    userEmail: DEFAULT_USER_EMAIL,
  };
}

describe("useDriveOnDemandFetch", () => {
  beforeEach(async () => {
    await db.files.clear();
    localStorage.clear();
    useDriveStore.setState({ isLoadingTracks: true });
    mockedFetch.mockReset();
    mockedCaptureError.mockReset();
  });

  afterEach(async () => {
    await db.files.clear();
  });

  it("virtual root: clears the skeleton and performs no Drive/Dexie work", async () => {
    const whereSpy = vi.spyOn(db.files, "where");
    try {
      renderHook(() => {
        useDriveOnDemandFetch({
          currentFolderId: VIRTUAL_ROOT_ID,
          token: "tok",
        });
      });

      await waitFor(() => {
        expect(useDriveStore.getState().isLoadingTracks).toBe(false);
      });
      expect(mockedFetch).not.toHaveBeenCalled();
      expect(whereSpy).not.toHaveBeenCalled();
    } finally {
      whereSpy.mockRestore();
    }
  });

  it("normal folder: still runs the on-demand fetch (behavior unchanged)", async () => {
    mockedFetch.mockResolvedValue(emptyPage());

    renderHook(() => {
      useDriveOnDemandFetch({ currentFolderId: "folder-1", token: "tok" });
    });

    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(useDriveStore.getState().isLoadingTracks).toBe(false);
    });
  });

  it("writes a child with omitted parents under the listed folder and keeps the row's own parents", async () => {
    mockedFetch.mockResolvedValue({
      ok: true,
      json: () => ({
        files: [
          {
            id: "no-parents",
            name: "a.mp3",
            mimeType: "audio/mpeg",
            size: "5",
          },
          {
            id: "own-parents",
            name: "b.mp3",
            mimeType: "audio/mpeg",
            parents: ["folder-9"],
            size: "6",
          },
        ],
      }),
    } as unknown as Response);

    renderHook(() => {
      useDriveOnDemandFetch({ currentFolderId: "folder-1", token: "tok" });
    });

    await waitFor(async () => {
      expect(
        await db.files.get([DEFAULT_USER_EMAIL, "no-parents"]),
      ).toBeDefined();
      expect(
        await db.files.get([DEFAULT_USER_EMAIL, "own-parents"]),
      ).toBeDefined();
    });

    // The listing query proves direct membership; a response that omits
    // parents is persisted under the folder being listed, never "root".
    expect(
      (await db.files.get([DEFAULT_USER_EMAIL, "no-parents"]))?.parentId,
    ).toBe("folder-1");
    // The row's own parents still wins over the listing knownParents.
    expect(
      (await db.files.get([DEFAULT_USER_EMAIL, "own-parents"]))?.parentId,
    ).toBe("folder-9");
  });

  it("root: gates a Drive-substring leak out of the mirror but still counts its id for the prune", async () => {
    // "Movie.mkv.bak" ends with neither a playable extension nor a known
    // video-noise suffix, so it is simply not playable. "App.tsx" is the
    // '.ts' substring hazard. Both are returned by the query and must not be
    // upserted; the folder and the real media row must be.
    await db.files.put(cachedRow("leak-already-cached", false));
    const page = {
      ok: true,
      json: () => ({
        files: [
          {
            id: "leak-mkv-bak",
            name: "Movie.mkv.bak",
            mimeType: "application/octet-stream",
            size: "9",
          },
          {
            id: "leak-tsx",
            name: "App.tsx",
            mimeType: "application/octet-stream",
          },
          {
            id: "leak-already-cached",
            name: "App.tsx",
            mimeType: "application/octet-stream",
          },
          {
            id: "legit-video",
            name: "Movie.mkv",
            mimeType: "video/x-matroska",
            size: "10",
          },
          { id: "api-folder", name: "API Folder", mimeType: FOLDER_MIME },
        ],
      }),
    } as unknown as Response;
    mockedFetch.mockResolvedValue(page);

    renderHook(() => {
      useDriveOnDemandFetch({ currentFolderId: ROOT_FOLDER_ID, token: "tok" });
    });

    await waitFor(async () => {
      expect(
        await db.files.get([DEFAULT_USER_EMAIL, "legit-video"]),
      ).toBeDefined();
      expect(
        await db.files.get([DEFAULT_USER_EMAIL, "api-folder"]),
      ).toBeDefined();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Gate: leaked names never become rows.
    expect(
      await db.files.get([DEFAULT_USER_EMAIL, "leak-mkv-bak"]),
    ).toBeUndefined();
    expect(
      await db.files.get([DEFAULT_USER_EMAIL, "leak-tsx"]),
    ).toBeUndefined();

    // Prune got the UNFILTERED id set: a previously cached leak row is still
    // "seen by Drive" and therefore not deleted (no delete-and-refetch churn).
    expect(
      await db.files.get([DEFAULT_USER_EMAIL, "leak-already-cached"]),
    ).toBeDefined();
    expect(mockedCaptureError).not.toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining(
          "pruned-stale-root-rows",
        ) as unknown as string,
      }),
    );
  });

  it("root: prunes poisoned cached root rows after a complete listing", async () => {
    await db.files.bulkPut([
      cachedRow("poison-folder", true),
      cachedRow("poison-media", false),
      cachedRow("legit", false),
    ]);
    mockedFetch.mockResolvedValue({
      ok: true,
      json: () => ({
        files: [
          {
            id: "legit",
            name: "legit.mp3",
            mimeType: "audio/mpeg",
            size: "1",
          },
          { id: "api-folder", name: "API Folder", mimeType: FOLDER_MIME },
        ],
      }),
    } as unknown as Response);

    renderHook(() => {
      useDriveOnDemandFetch({ currentFolderId: ROOT_FOLDER_ID, token: "tok" });
    });

    await waitFor(async () => {
      expect(
        await db.files.get([DEFAULT_USER_EMAIL, "poison-folder"]),
      ).toBeUndefined();
      expect(
        await db.files.get([DEFAULT_USER_EMAIL, "poison-media"]),
      ).toBeUndefined();
    });
    // Rows the API still returns (and rows it returned now) are kept.
    expect(await db.files.get([DEFAULT_USER_EMAIL, "legit"])).toBeDefined();
    expect(
      await db.files.get([DEFAULT_USER_EMAIL, "api-folder"]),
    ).toBeDefined();

    // The listing really was the Drive root bucket.
    const firstCall = mockedFetch.mock.calls[0]?.[0];
    const firstCallUrl = typeof firstCall === "string" ? firstCall : "";
    expect(firstCallUrl).not.toBe("");
    expect(new URL(firstCallUrl).searchParams.get("q")).toContain(
      "'root' in parents",
    );
    expect(mockedCaptureError).toHaveBeenCalledWith({
      level: "warn",
      source: "db/pruneRootRows",
      message: "pruned-stale-root-rows: deletedCount=2",
    });
  });

  it("non-root listing never prunes cached root rows", async () => {
    await db.files.put(cachedRow("stale-root", false));
    mockedFetch.mockResolvedValue(emptyPage());

    renderHook(() => {
      useDriveOnDemandFetch({ currentFolderId: "folder-1", token: "tok" });
    });

    await waitFor(() => {
      expect(useDriveStore.getState().isLoadingTracks).toBe(false);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(
      await db.files.get([DEFAULT_USER_EMAIL, "stale-root"]),
    ).toBeDefined();
    expect(mockedCaptureError).not.toHaveBeenCalled();
  });

  it("failed root listing (HTTP error) does not prune cached rows", async () => {
    await db.files.put(cachedRow("stale-root", true));
    // 404 is non-retryable for driveFetch, so the listing fails immediately.
    mockedFetch.mockResolvedValue({
      ok: false,
      status: 404,
    } as unknown as Response);

    renderHook(() => {
      useDriveOnDemandFetch({ currentFolderId: ROOT_FOLDER_ID, token: "tok" });
    });

    await waitFor(() => {
      expect(useDriveStore.getState().isLoadingTracks).toBe(false);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(
      await db.files.get([DEFAULT_USER_EMAIL, "stale-root"]),
    ).toBeDefined();
    expect(mockedCaptureError).not.toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining(
          "pruned-stale-root-rows",
        ) as unknown as string,
      }),
    );
  });

  it("a failed Dexie write does not prune cached root rows", async () => {
    await db.files.put(cachedRow("stale-root", false));
    mockedFetch.mockResolvedValue({
      ok: true,
      json: () => ({
        files: [{ id: "new-row", name: "new.mp3", mimeType: "audio/mpeg" }],
      }),
    } as unknown as Response);
    const bulkPutSpy = vi
      .spyOn(db.files, "bulkPut")
      .mockRejectedValueOnce(new Error("QuotaExceededError"));

    try {
      renderHook(() => {
        useDriveOnDemandFetch({
          currentFolderId: ROOT_FOLDER_ID,
          token: "tok",
        });
      });

      await waitFor(() => {
        expect(bulkPutSpy).toHaveBeenCalledTimes(1);
      });
      await waitFor(() => {
        expect(useDriveStore.getState().isLoadingTracks).toBe(false);
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(
        await db.files.get([DEFAULT_USER_EMAIL, "stale-root"]),
      ).toBeDefined();
    } finally {
      bulkPutSpy.mockRestore();
    }
  });

  async function expectMalformedRootBodyKeepsPoison(body: unknown) {
    await db.files.put(cachedRow("poison", false));
    mockedFetch.mockResolvedValue({
      ok: true,
      json: () => body,
    } as unknown as Response);

    renderHook(() => {
      useDriveOnDemandFetch({ currentFolderId: ROOT_FOLDER_ID, token: "tok" });
    });

    await waitFor(() => {
      expect(useDriveStore.getState().isLoadingTracks).toBe(false);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // A malformed 200 must never be treated as an authoritative empty listing.
    expect(await db.files.get([DEFAULT_USER_EMAIL, "poison"])).toBeDefined();
    expect(mockedCaptureError).not.toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining(
          "pruned-stale-root-rows",
        ) as unknown as string,
      }),
    );
  }

  it("malformed root 200 body {} does not prune cached rows", async () => {
    await expectMalformedRootBodyKeepsPoison({});
  });

  it("malformed root 200 body [] does not prune cached rows", async () => {
    await expectMalformedRootBodyKeepsPoison([]);
  });

  it("malformed root 200 body that is a JSON string does not prune", async () => {
    await expectMalformedRootBodyKeepsPoison("ok");
  });

  it("valid empty root listing ({ files: [] }) prunes poisoned rows", async () => {
    await db.files.put(cachedRow("poison", true));
    mockedFetch.mockResolvedValue({
      ok: true,
      json: () => ({ files: [] }),
    } as unknown as Response);

    renderHook(() => {
      useDriveOnDemandFetch({ currentFolderId: ROOT_FOLDER_ID, token: "tok" });
    });

    await waitFor(async () => {
      expect(
        await db.files.get([DEFAULT_USER_EMAIL, "poison"]),
      ).toBeUndefined();
    });
    expect(mockedCaptureError).toHaveBeenCalledWith({
      level: "warn",
      source: "db/pruneRootRows",
      message: "pruned-stale-root-rows: deletedCount=1",
    });
  });
});
