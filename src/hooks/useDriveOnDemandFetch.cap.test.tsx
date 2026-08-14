// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { db } from "../db/db";
import { useDriveOnDemandFetch } from "./useDriveOnDemandFetch";
import { useDriveStore } from "../store/driveStore";

// Deterministic toast text: the real i18n instance would fall back to the
// defaultValue anyway, but stubbing keeps the assert exact.
vi.mock("../i18n", () => ({
  default: {
    t: (key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? key,
  },
}));

vi.mock("../utils/apiClient", () => ({
  fetchWithAuth: vi.fn(),
}));
import { fetchWithAuth } from "../utils/apiClient";
const mockedFetch = vi.mocked(fetchWithAuth);

const FOLDER_ID = "cap-folder";

function makeDriveFile(idx: number) {
  return {
    id: `cap-f${String(idx)}`,
    name: `track-${String(idx)}.mp3`,
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

describe("useDriveOnDemandFetch — MAX_PAGINATION_PAGES safety cap (Task 14)", () => {
  beforeEach(async () => {
    await db.files.clear();
    useDriveStore.setState({ isLoadingTracks: false });
    mockedFetch.mockReset();
    // simpleToast appends to document.body and removes after ~3s; a toast
    // left by the previous test would poison the "no notify" assertion.
    document.body.innerHTML = "";
  });

  afterEach(async () => {
    await db.files.clear();
  });

  it("stops after 10 pages when Drive keeps issuing nextPageToken, and notifies the user once", async () => {
    for (let i = 0; i < 11; i++) {
      mockedFetch.mockResolvedValueOnce(
        makePage([makeDriveFile(i)], "still-more"),
      );
    }

    renderHook(() => {
      useDriveOnDemandFetch({ currentFolderId: FOLDER_ID, token: "tok" });
    });

    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledTimes(10);
    });

    const count = await db.files.where("parentId").equals(FOLDER_ID).count();
    expect(count).toBe(10);

    // Soft notification instead of hanging: the toast carries the fallback
    // text (i18n keys land in translation.json after the cover branch merges).
    await waitFor(() => {
      expect(document.body.textContent ?? "").toContain("10,000");
    });
  });

  it("does not notify when the list ends naturally before the cap", async () => {
    mockedFetch
      .mockResolvedValueOnce(makePage([makeDriveFile(0)], "page-2"))
      .mockResolvedValueOnce(makePage([makeDriveFile(1)]));

    renderHook(() => {
      useDriveOnDemandFetch({ currentFolderId: FOLDER_ID, token: "tok" });
    });

    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledTimes(2);
    });

    const count = await db.files.where("parentId").equals(FOLDER_ID).count();
    expect(count).toBe(2);
    expect(document.body.textContent ?? "").not.toContain("10,000");
  });
});
