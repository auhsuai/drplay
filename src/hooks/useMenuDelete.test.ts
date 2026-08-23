// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";
import type { DriveItem } from "../types";

const deleteFileMock = vi.hoisted(() => vi.fn());
vi.mock("../utils/driveApi", () => ({ deleteFile: deleteFileMock }));

const dbMock = vi.hoisted(() => ({
  files: { delete: vi.fn() },
}));
vi.mock("../db/db", () => ({ db: dbMock }));

const stopPlaybackIfTrackMock = vi.hoisted(() => vi.fn());
vi.mock("../utils/stopPlayback", () => ({
  stopPlaybackIfTrack: stopPlaybackIfTrackMock,
}));

const isUploadingMock = vi.hoisted(() => vi.fn());
vi.mock("../utils/uploadManager", () => ({ isUploading: isUploadingMock }));

const showErrorToastMock = vi.hoisted(() => vi.fn());
vi.mock("../utils/simpleToast", () => ({
  showErrorToast: showErrorToastMock,
}));

const captureErrorMock = vi.hoisted(() => vi.fn());
vi.mock("../utils/errorLog", () => ({ captureError: captureErrorMock }));

import { useMenuDelete } from "./useMenuDelete";

const t = ((key: string) => key) as unknown as TFunction;

function makeItem(overrides: Partial<DriveItem> = {}): DriveItem {
  return { id: "file-1", title: "Song", isFolder: false, ...overrides };
}

async function runDelete(callbacks: {
  onRemoveItem?: (id: string) => void;
  onRefresh?: () => void;
}) {
  const setIsOpen = vi.fn();
  const onClose = vi.fn();
  const { result } = renderHook(() => useMenuDelete(t));
  act(() => {
    result.current.openDeleteConfirm(makeItem());
  });
  await act(async () => {
    await result.current.handleDelete(
      "tok",
      setIsOpen,
      onClose,
      callbacks.onRemoveItem,
      callbacks.onRefresh,
    );
  });
  return { result, setIsOpen, onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
  isUploadingMock.mockReturnValue(false);
  deleteFileMock.mockResolvedValue(undefined);
  dbMock.files.delete.mockResolvedValue(undefined);
});

describe("useMenuDelete happy path", () => {
  it("deletes remotely, stops playback of the track, removes the item from view", async () => {
    const onRemoveItem = vi.fn();
    const onRefresh = vi.fn();
    const { setIsOpen } = await runDelete({ onRemoveItem, onRefresh });

    expect(deleteFileMock).toHaveBeenCalledWith("tok", "file-1");
    expect(stopPlaybackIfTrackMock).toHaveBeenCalledWith("file-1");
    expect(dbMock.files.delete).toHaveBeenCalledWith("file-1");
    expect(onRemoveItem).toHaveBeenCalledWith("file-1");
    expect(onRefresh).not.toHaveBeenCalled();
    expect(setIsOpen).toHaveBeenCalledWith(false);
    expect(showErrorToastMock).not.toHaveBeenCalled();
    expect(captureErrorMock).not.toHaveBeenCalled();
  });
});

describe("useMenuDelete partial failure (remote OK, local Dexie fail)", () => {
  it("does NOT surface a delete_error toast; playback stops and the item is removed anyway", async () => {
    deleteFileMock.mockResolvedValue(undefined);
    dbMock.files.delete.mockRejectedValue(new Error("dexie down"));
    const onRemoveItem = vi.fn();

    const { setIsOpen } = await runDelete({ onRemoveItem });

    // Playback already stopped after the successful remote delete.
    expect(stopPlaybackIfTrackMock).toHaveBeenCalledWith("file-1");
    // Local-only failure must not read as a failed delete to the user.
    expect(showErrorToastMock).not.toHaveBeenCalledWith("drive.delete_error");
    expect(showErrorToastMock).not.toHaveBeenCalled();
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warn", source: "useMenuDelete" }),
    );
    // UI still reflects remote truth like the success path.
    expect(onRemoveItem).toHaveBeenCalledWith("file-1");
    expect(setIsOpen).toHaveBeenCalledWith(false);
  });

  it("falls back to onRefresh when no onRemoveItem is provided despite the local cache failure", async () => {
    deleteFileMock.mockResolvedValue(undefined);
    dbMock.files.delete.mockRejectedValue(new Error("dexie down"));
    const onRefresh = vi.fn();

    await runDelete({ onRefresh });

    expect(stopPlaybackIfTrackMock).toHaveBeenCalledWith("file-1");
    expect(showErrorToastMock).not.toHaveBeenCalled();
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warn" }),
    );
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

describe("useMenuDelete remote failure (unchanged behavior)", () => {
  it("shows delete_error and skips UI updates/playback-stop when the Drive delete fails", async () => {
    deleteFileMock.mockRejectedValue(new Error("HTTP 403"));
    const onRemoveItem = vi.fn();
    const onRefresh = vi.fn();

    await runDelete({ onRemoveItem, onRefresh });

    expect(showErrorToastMock).toHaveBeenCalledWith("drive.delete_error");
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ level: "error" }),
    );
    expect(stopPlaybackIfTrackMock).not.toHaveBeenCalled();
    expect(dbMock.files.delete).not.toHaveBeenCalled();
    expect(onRemoveItem).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
  });
});
