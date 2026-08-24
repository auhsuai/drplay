// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { db } from "../db/db";
import { useDriveExplorer } from "./useDriveExplorer";
import { useDriveStore } from "../store/driveStore";
import { getUploadState, subscribe } from "../utils/uploadManager";
import { driveFetch } from "../utils/driveApi";

// Network layer mocked (mirrors useDriveExplorer.bulkGuards.test.tsx);
// uploadManager mocked so the pin partition can be driven by explicit
// getUploadState verdicts + a captured subscribe callback (version bump).
// Dexie stays real (fake-indexeddb).
vi.mock("../utils/apiClient", () => ({
  fetchWithAuth: vi.fn(),
}));
vi.mock("../utils/uploadManager", () => ({
  isUploading: vi.fn(),
  getUploadingIds: vi.fn(),
  getUploadState: vi.fn(),
  subscribe: vi.fn(),
}));
vi.mock("../utils/driveApi", () => ({
  deleteFile: vi.fn(),
  moveFile: vi.fn(),
  createFolder: vi.fn(),
  driveFetch: vi.fn(),
}));
vi.mock("../utils/simpleToast", () => ({
  showErrorToast: vi.fn(),
}));

const mockedGetUploadState = vi.mocked(getUploadState);
const mockedSubscribe = vi.mocked(subscribe);
const mockedDriveFetch = vi.mocked(driveFetch);

const FOLDER_ID = "pin-folder";
const TOKEN = "pin-token";

type MockUploadState = "none" | "uploading" | "parent-uploading" | "uploaded";

// Captured by the subscribe mock; the hook wraps it with its module-level
// version bump, so invoking it re-runs the pin partition (RED→GREEN proof
// that useSyncExternalStore + version counter pattern is wired).
let notifyUploadStoreChange: (() => void) | null = null;

function makeFile(id: string, name: string, isFolder = false) {
  return {
    id,
    name,
    parentId: FOLDER_ID,
    mimeType: isFolder ? "application/vnd.google-apps.folder" : "audio/mpeg",
    size: 1000,
    modifiedTime: "2024-01-01T00:00:00.000Z",
    trashed: false,
    isFolder,
    userEmail: "default", // compound PK part (schema v10)
  };
}

function mockUploadStates(states: Record<string, MockUploadState>) {
  mockedGetUploadState.mockImplementation((id: string) => states[id] ?? "none");
}

beforeEach(async () => {
  await db.files.clear();
  useDriveStore.setState({ isLoadingTracks: false });
  notifyUploadStoreChange = null;
  mockedGetUploadState.mockReset();
  mockedGetUploadState.mockReturnValue("none");
  mockedSubscribe.mockReset();
  mockedSubscribe.mockImplementation((cb: () => void) => {
    notifyUploadStoreChange = cb;
    return () => {
      if (notifyUploadStoreChange === cb) notifyUploadStoreChange = null;
    };
  });
  // fetchOnDemand runs on mount with the real token; a non-retryable 404 keeps
  // it out of the way (no retries, no real-time backoff).
  mockedDriveFetch.mockReset();
  mockedDriveFetch.mockResolvedValue({
    ok: false,
    status: 404,
  } as unknown as Response);
});

afterEach(async () => {
  await db.files.clear();
});

function renderExplorer() {
  return renderHook(() =>
    useDriveExplorer(FOLDER_ID, "Folder", TOKEN, () => {}),
  );
}

describe("useDriveExplorer upload pin: uploading items are pinned to the top", () => {
  it("pins an uploading item to the top of the list despite the name sort (default name_natural)", async () => {
    await db.files.bulkPut([
      makeFile("id-a", "A.mp3"),
      makeFile("id-z", "Zik On Air.mp3"),
    ]);
    mockUploadStates({ "id-z": "uploading" });

    const { result } = renderExplorer();
    await waitFor(() => {
      expect(result.current.filteredItems).toHaveLength(2);
    });

    expect(result.current.filteredItems.map((i) => i.id)).toEqual([
      "id-z",
      "id-a",
    ]);
    expect(result.current.currentItems.map((i) => i.id)).toEqual([
      "id-z",
      "id-a",
    ]);
  });

  it("does NOT pin a folder whose child is uploading (parent-uploading sorts normally)", async () => {
    await db.files.bulkPut([
      makeFile("id-afolder", "AFolder", true),
      makeFile("id-zfolder", "ZFolder", true),
    ]);
    mockUploadStates({ "id-zfolder": "parent-uploading" });

    const { result } = renderExplorer();
    await waitFor(() => {
      expect(result.current.filteredItems).toHaveLength(2);
    });

    // If pinned, ZFolder would be first; a parent-uploading folder must keep
    // its normal sorted position (AFolder first).
    expect(result.current.filteredItems.map((i) => i.id)).toEqual([
      "id-afolder",
      "id-zfolder",
    ]);
  });

  it("pins all uploading items on top, keeping their dbFiles (insertion) order", async () => {
    await db.files.bulkPut([
      makeFile("id-a", "A.mp3"),
      makeFile("id-m", "M.mp3"),
      makeFile("id-z1", "Zed One.mp3"),
      makeFile("id-z2", "Zed Two.mp3"),
    ]);
    mockUploadStates({ "id-z1": "uploading", "id-z2": "uploading" });

    const { result } = renderExplorer();
    await waitFor(() => {
      expect(result.current.filteredItems).toHaveLength(4);
    });

    expect(result.current.filteredItems.map((i) => i.id)).toEqual([
      "id-z1",
      "id-z2",
      "id-a",
      "id-m",
    ]);
  });

  it('pins a just-finished ("uploaded") item ABOVE uploading items and the rest (tint must be immediately visible)', async () => {
    await db.files.bulkPut([
      makeFile("id-a", "A.mp3"),
      makeFile("id-u", "Zed Uploading.mp3"),
      makeFile("id-done", "M Done.mp3"),
    ]);
    mockUploadStates({ "id-done": "uploaded", "id-u": "uploading" });

    const { result } = renderExplorer();
    await waitFor(() => {
      expect(result.current.filteredItems).toHaveLength(3);
    });

    // uploaded trước, uploading sau, rồi restItems theo sort bình thường —
    // file vừa tải xong nổi bật nhất + check thấy ngay.
    expect(result.current.filteredItems.map((i) => i.id)).toEqual([
      "id-done",
      "id-u",
      "id-a",
    ]);
    expect(result.current.currentItems.map((i) => i.id)).toEqual([
      "id-done",
      "id-u",
      "id-a",
    ]);
  });

  it("does NOT pin an item whose state is none (tint dismissed/expired → sorted position)", async () => {
    await db.files.bulkPut([
      makeFile("id-a", "A.mp3"),
      makeFile("id-b", "B.mp3"),
    ]);
    mockUploadStates({ "id-b": "none" });

    const { result } = renderExplorer();
    await waitFor(() => {
      expect(result.current.filteredItems).toHaveLength(2);
    });

    expect(result.current.filteredItems.map((i) => i.id)).toEqual([
      "id-a",
      "id-b",
    ]);
  });

  it("does NOT pin when a global search query is active (search results keep their own sort)", async () => {
    await db.files.bulkPut([
      makeFile("id-a", "A.mp3"),
      makeFile("id-z", "Zed.mp3"),
    ]);
    mockUploadStates({ "id-z": "uploading" });

    const { result } = renderExplorer();
    await waitFor(() => {
      expect(result.current.filteredItems).toHaveLength(2);
    });

    act(() => {
      result.current.setSearchQuery("mp3");
    });

    await waitFor(() => {
      expect(result.current.filteredItems.length).toBeGreaterThan(0);
    });
    expect(result.current.filteredItems.map((i) => i.id)).toEqual([
      "id-a",
      "id-z",
    ]);
  });
});

describe("useDriveExplorer upload pin: version bump re-sorts on upload state change", () => {
  it("pins the item as soon as an upload starts (subscribe fires -> re-sort)", async () => {
    await db.files.bulkPut([
      makeFile("id-a", "A.mp3"),
      makeFile("id-z", "Z.mp3"),
    ]);
    mockUploadStates({});

    const { result } = renderExplorer();
    await waitFor(() => {
      expect(result.current.filteredItems).toHaveLength(2);
    });
    expect(result.current.filteredItems.map((i) => i.id)).toEqual([
      "id-a",
      "id-z",
    ]);

    // Upload starts: uploadManager writes the pending row and notifies.
    mockUploadStates({ "id-z": "uploading" });
    act(() => {
      notifyUploadStoreChange?.();
    });

    await waitFor(() => {
      expect(result.current.filteredItems.map((i) => i.id)).toEqual([
        "id-z",
        "id-a",
      ]);
    });
  });

  it("re-sorts an item back to its normal position after its upload finishes (state -> none + version bump)", async () => {
    await db.files.bulkPut([
      makeFile("id-a", "A.mp3"),
      makeFile("id-z", "Z.mp3"),
    ]);
    mockUploadStates({ "id-z": "uploading" });

    const { result } = renderExplorer();
    await waitFor(() => {
      expect(result.current.filteredItems.map((i) => i.id)).toEqual([
        "id-z",
        "id-a",
      ]);
    });

    // Upload finishes: uploadManager swaps pending row for the real row and
    // notifies; getUploadState now reports 'none' for the real drive id.
    mockUploadStates({});
    act(() => {
      notifyUploadStoreChange?.();
    });

    await waitFor(() => {
      expect(result.current.filteredItems.map((i) => i.id)).toEqual([
        "id-a",
        "id-z",
      ]);
    });
  });
});
