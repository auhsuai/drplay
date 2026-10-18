// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { db } from "../db/db";
import { useDriveStore } from "../store/driveStore";
import { VIRTUAL_ROOT_ID } from "../utils/driveConstants";
import { useDriveOnDemandFetch } from "./useDriveOnDemandFetch";

// Mock the network layer only; keep real Dexie (fake-indexeddb) so any Dexie
// access would be observable.
vi.mock("../utils/apiClient", () => ({
  fetchWithAuth: vi.fn(),
}));
import { fetchWithAuth } from "../utils/apiClient";
const mockedFetch = vi.mocked(fetchWithAuth);

function emptyPage(): Response {
  return {
    ok: true,
    json: () => ({ files: [] }),
  } as unknown as Response;
}

describe("useDriveOnDemandFetch", () => {
  beforeEach(async () => {
    await db.files.clear();
    localStorage.clear();
    useDriveStore.setState({ isLoadingTracks: true });
    mockedFetch.mockReset();
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
});
