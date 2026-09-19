// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db/db";

const deleteFileMock = vi.hoisted(() =>
  vi.fn<(token: string, fileId: string) => Promise<void>>(),
);
const moveFileMock = vi.hoisted(() =>
  vi.fn<
    (
      token: string,
      fileId: string,
      currentParentId: string,
      newParentId: string,
    ) => Promise<void>
  >(),
);
const createFolderMock = vi.hoisted(() => vi.fn());
const captureErrorMock = vi.hoisted(() => vi.fn());
const showErrorToastMock = vi.hoisted(() => vi.fn());
const stopPlaybackIfTrackMock = vi.hoisted(() => vi.fn());
const removeTracksByDriveIdsMock = vi.hoisted(() => vi.fn());

// Mock the network layer only; keep real Dexie (fake-indexeddb) so the
// local-mirror write path is exercised for real.
vi.mock("../utils/driveApi", () => ({
  deleteFile: deleteFileMock,
  moveFile: moveFileMock,
  createFolder: createFolderMock,
  FOLDER_MIME: "application/vnd.google-apps.folder",
}));

vi.mock("../utils/errorLog", () => ({ captureError: captureErrorMock }));
vi.mock("../utils/simpleToast", () => ({
  showErrorToast: showErrorToastMock,
}));
vi.mock("../utils/stopPlayback", () => ({
  stopPlaybackIfTrack: stopPlaybackIfTrackMock,
}));
vi.mock("../store/queueOps", () => ({
  removeTracksByDriveIds: removeTracksByDriveIdsMock,
}));
vi.mock("i18next", () => ({ t: (key: string) => key }));

import { useDriveBulkOps } from "./useDriveBulkOps";

const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

function renderBulkOps(ids: string[], onRemoveItem?: (id: string) => void) {
  const removeItem = onRemoveItem ?? vi.fn();
  const { result } = renderHook(() =>
    useDriveBulkOps({
      token: "tok",
      currentFolderId: "folder-1",
      selectedIds: new Set(ids),
      onRemoveItem: removeItem,
      onRefresh: vi.fn(),
      setSelectedIds: vi.fn(),
      setIsSelectionMode: vi.fn(),
    }),
  );
  return { result, onRemoveItem: removeItem };
}

beforeEach(async () => {
  vi.clearAllMocks();
  deleteFileMock.mockResolvedValue(undefined);
  moveFileMock.mockResolvedValue(undefined);
  await db.files.clear();
});

describe("useDriveBulkOps failure log format (B11-1)", () => {
  it("logs bulk-delete failures with the sanitizer-matching fileId= form", async () => {
    deleteFileMock.mockImplementation((_token, fileId) =>
      fileId === "abc123"
        ? Promise.reject(new Error("Drive 404"))
        : Promise.resolve(undefined),
    );
    const { result, onRemoveItem } = renderBulkOps(["abc123", "ok1"]);

    await act(async () => {
      await result.current.handleBulkDelete(vi.fn());
    });

    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        source: "useDriveBulkOps",
        message: "bulk-delete failed for fileId=abc123: Drive 404",
      }),
    );
    // Contract preserved: only the successful id is evicted, failed id is not.
    expect(onRemoveItem).toHaveBeenCalledTimes(1);
    expect(onRemoveItem).toHaveBeenCalledWith("ok1");
    expect(showErrorToastMock).toHaveBeenCalledWith("drive.delete_error");
  });

  it("logs bulk-move failures with the sanitizer-matching fileId= form", async () => {
    moveFileMock.mockImplementation((_token, fileId) =>
      fileId === "def456"
        ? Promise.reject(new Error("Drive 500"))
        : Promise.resolve(undefined),
    );
    const { result, onRemoveItem } = renderBulkOps(["def456", "ok2"]);

    await act(async () => {
      await result.current.handleBulkMove("dest-1", vi.fn());
    });

    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        source: "useDriveBulkOps",
        message: "bulk-move failed for fileId=def456: Drive 500",
      }),
    );
    expect(onRemoveItem).toHaveBeenCalledTimes(1);
    expect(onRemoveItem).toHaveBeenCalledWith("ok2");
    expect(showErrorToastMock).toHaveBeenCalledWith("drive.move_error");
  });
});

describe("useDriveBulkOps local-mirror independence (B11-4)", () => {
  it("still evicts successfully deleted ids when the Dexie bulkDelete fails", async () => {
    const bulkDeleteSpy = vi
      .spyOn(db.files, "bulkDelete")
      .mockRejectedValueOnce(new Error("idb down"));
    try {
      const { result, onRemoveItem } = renderBulkOps(["m1", "m2"]);

      await act(async () => {
        await result.current.handleBulkDelete(vi.fn());
      });

      // Both Drive deletes succeeded, so the queue eviction must run even
      // though the local mirror write failed (it is logged, not rethrown).
      expect(bulkDeleteSpy).toHaveBeenCalledTimes(1);
      expect(onRemoveItem).toHaveBeenCalledTimes(2);
      expect(onRemoveItem).toHaveBeenCalledWith("m1");
      expect(onRemoveItem).toHaveBeenCalledWith("m2");
      expect(captureErrorMock).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "error",
          source: "useDriveBulkOps",
          message: expect.stringContaining(
            "local-mirror-delete-failed",
          ) as unknown as string,
        }),
      );
      // No Drive-side failure -> no error toast (contract preserved).
      expect(showErrorToastMock).not.toHaveBeenCalled();
    } finally {
      bulkDeleteSpy.mockRestore();
    }
  });

  it("still evicts successfully moved ids when the Dexie bulkUpdate fails", async () => {
    const bulkUpdateSpy = vi
      .spyOn(db.files, "bulkUpdate")
      .mockRejectedValueOnce(new Error("idb down"));
    try {
      const { result, onRemoveItem } = renderBulkOps(["m1", "m2"]);

      await act(async () => {
        await result.current.handleBulkMove("dest-1", vi.fn());
      });

      expect(bulkUpdateSpy).toHaveBeenCalledTimes(1);
      expect(onRemoveItem).toHaveBeenCalledTimes(2);
      expect(onRemoveItem).toHaveBeenCalledWith("m1");
      expect(onRemoveItem).toHaveBeenCalledWith("m2");
      expect(captureErrorMock).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "error",
          source: "useDriveBulkOps",
          message: expect.stringContaining(
            "local-mirror-move-failed",
          ) as unknown as string,
        }),
      );
      expect(showErrorToastMock).not.toHaveBeenCalled();
    } finally {
      bulkUpdateSpy.mockRestore();
    }
  });
});

describe("useDriveBulkOps bounded concurrency (B11-5)", () => {
  it("runs deletes in batches of at most 5 instead of one-at-a-time", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `p${String(i)}`);
    const pending = new Map<string, () => void>();
    deleteFileMock.mockImplementation(
      (_token, fileId) =>
        new Promise<void>((resolve) => {
          pending.set(fileId, resolve);
        }),
    );
    const { result, onRemoveItem } = renderBulkOps(ids);

    let batch: Promise<void> = Promise.resolve();
    act(() => {
      batch = result.current.handleBulkDelete(vi.fn());
    });
    await act(async () => {
      await flushMicrotasks();
    });

    // Exactly 5 in flight: not 1 (the old serial loop) and not 10 (unbounded).
    expect(deleteFileMock).toHaveBeenCalledTimes(5);
    const firstFive = ids.slice(0, 5);
    const lastFive = ids.slice(5);

    firstFive.forEach((id) => pending.get(id)?.());
    await act(async () => {
      await flushMicrotasks();
    });

    // Every queued item has started once the released slots free up.
    expect(deleteFileMock).toHaveBeenCalledTimes(10);

    lastFive.forEach((id) => pending.get(id)?.());
    await act(async () => {
      await batch;
    });

    expect(onRemoveItem).toHaveBeenCalledTimes(10);
    expect(captureErrorMock).not.toHaveBeenCalled();
    expect(showErrorToastMock).not.toHaveBeenCalled();
  });
});

describe("useDriveBulkOps queue eviction (F7-8)", () => {
  it("delete thành công hết → evict 1 lần với đủ các id", async () => {
    const { result } = renderBulkOps(["ok1", "ok2"]);

    await act(async () => {
      await result.current.handleBulkDelete(vi.fn());
    });

    expect(removeTracksByDriveIdsMock).toHaveBeenCalledTimes(1);
    expect(removeTracksByDriveIdsMock).toHaveBeenCalledWith(["ok1", "ok2"]);
  });

  it("có id fail → chỉ evict các id delete thành công", async () => {
    deleteFileMock.mockImplementation((_token, fileId) =>
      fileId === "bad"
        ? Promise.reject(new Error("Drive 404"))
        : Promise.resolve(undefined),
    );
    const { result } = renderBulkOps(["bad", "ok1", "ok2"]);

    await act(async () => {
      await result.current.handleBulkDelete(vi.fn());
    });

    expect(removeTracksByDriveIdsMock).toHaveBeenCalledTimes(1);
    expect(removeTracksByDriveIdsMock).toHaveBeenCalledWith(["ok1", "ok2"]);
  });

  it("mirror bulkDelete fail → vẫn evict (Drive là source of truth)", async () => {
    const bulkDeleteSpy = vi
      .spyOn(db.files, "bulkDelete")
      .mockRejectedValueOnce(new Error("idb down"));
    try {
      const { result } = renderBulkOps(["m1", "m2"]);

      await act(async () => {
        await result.current.handleBulkDelete(vi.fn());
      });

      expect(removeTracksByDriveIdsMock).toHaveBeenCalledWith(["m1", "m2"]);
    } finally {
      bulkDeleteSpy.mockRestore();
    }
  });

  it("không id nào delete thành công → không evict", async () => {
    deleteFileMock.mockRejectedValue(new Error("Drive 500"));
    const { result } = renderBulkOps(["bad1", "bad2"]);

    await act(async () => {
      await result.current.handleBulkDelete(vi.fn());
    });

    expect(removeTracksByDriveIdsMock).not.toHaveBeenCalled();
  });
});
