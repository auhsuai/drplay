// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { db } from "../db/db";
import { useDriveOnDemandFetch } from "./useDriveOnDemandFetch";
import { useDriveStore } from "../store/driveStore";
import { USER_EMAIL_KEY } from "../utils/storageKeys";
import { ROOT_FOLDER_ID } from "../utils/driveConstants";
import { FOLDER_MIME } from "../utils/driveApi";

// Deterministic toast text: the real i18n instance would fall back to the
// defaultValue anyway, but stubbing keeps the assert exact.
vi.mock("../i18n", () => ({
  default: {
    t: (key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? key,
  },
}));

// driveFetch resolves through fetchWithAuth — mock the transport, not the
// resilience layer, so pagination/abort behavior stays real.
vi.mock("../utils/apiClient", () => ({
  fetchWithAuth: vi.fn(),
}));
import { fetchWithAuth } from "../utils/apiClient";
const mockedFetch = vi.mocked(fetchWithAuth);

// Canonical-parent regression: the hook browses folder-X but Drive's own
// response is the single source of truth for where a file lives.
const BROWSED_FOLDER_ID = "folder-X";
const OWNER_EMAIL = "writer-b@example.com";

function makePage(
  files: Array<Record<string, unknown>>,
  nextPageToken?: string,
) {
  return {
    ok: true,
    json: () => ({ files, nextPageToken }),
  } as unknown as Response;
}

describe("useDriveOnDemandFetch — canonical parent rule (parent normalization step 4)", () => {
  beforeEach(async () => {
    await db.files.clear();
    useDriveStore.setState({ isLoadingTracks: false });
    mockedFetch.mockReset();
    localStorage.setItem(USER_EMAIL_KEY, OWNER_EMAIL);
  });

  afterEach(async () => {
    await db.files.clear();
    localStorage.removeItem(USER_EMAIL_KEY);
  });

  it("stores parents[0] of the response as parentId, NOT the browsed folder", async () => {
    mockedFetch.mockResolvedValueOnce(
      makePage([
        {
          id: "F",
          name: "song.mp3",
          mimeType: "audio/mpeg",
          // Drive says F lives in Y even though we queried folder-X.
          parents: ["Y"],
          size: "1000",
          modifiedTime: "2024-01-01T00:00:00.000Z",
        },
      ]),
    );

    renderHook(() => {
      useDriveOnDemandFetch({
        currentFolderId: BROWSED_FOLDER_ID,
        token: "tok",
      });
    });

    await waitFor(async () => {
      const row = await db.files.get([OWNER_EMAIL, "F"]);
      expect(row?.parentId).toBe("Y");
    });
  });

  it("falls back to ROOT_FOLDER_ID when the response carries no parents", async () => {
    mockedFetch.mockResolvedValueOnce(
      makePage([
        {
          id: "G",
          name: "loose.mp3",
          mimeType: "audio/mpeg",
          size: "5",
          modifiedTime: "2024-01-02T00:00:00.000Z",
        },
      ]),
    );

    renderHook(() => {
      useDriveOnDemandFetch({
        currentFolderId: BROWSED_FOLDER_ID,
        token: "tok",
      });
    });

    await waitFor(async () => {
      const row = await db.files.get([OWNER_EMAIL, "G"]);
      expect(row?.parentId).toBe(ROOT_FOLDER_ID);
    });
  });

  it("keeps the audio/folder classification and stamps the account email at write time", async () => {
    mockedFetch.mockResolvedValueOnce(
      makePage([
        {
          id: "H",
          name: "track.mp3",
          mimeType: "audio/mpeg",
          parents: ["Y"],
          size: "10",
          modifiedTime: "2024-01-03T00:00:00.000Z",
        },
        {
          id: "I",
          name: "album",
          mimeType: FOLDER_MIME,
          parents: ["Y"],
          modifiedTime: "2024-01-04T00:00:00.000Z",
        },
      ]),
    );

    renderHook(() => {
      useDriveOnDemandFetch({
        currentFolderId: BROWSED_FOLDER_ID,
        token: "tok",
      });
    });

    await waitFor(async () => {
      expect(await db.files.get([OWNER_EMAIL, "H"])).toBeDefined();
    });
    const audio = await db.files.get([OWNER_EMAIL, "H"]);
    const folder = await db.files.get([OWNER_EMAIL, "I"]);

    expect(audio?.trashed).toBe(false);
    expect(audio?.isFolder).toBe(false);
    expect(folder?.isFolder).toBe(true);
    // Compound-PK lookup above only matches rows stamped with OWNER_EMAIL;
    // assert it explicitly so a stamp drift cannot hide behind defaults.
    expect(audio?.userEmail).toBe(OWNER_EMAIL);
  });
});
