// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const mocks = vi.hoisted(() => {
  const store = {
    currentTrack: null as { id: string } | null,
    setCurrentTrack: vi.fn(),
    setIsPlaying: vi.fn(),
  };
  return {
    store,
    release: vi.fn(),
    getState: vi.fn(() => store),
    deleteFile: vi.fn(),
    showErrorToast: vi.fn(),
    bulkDelete: vi.fn(),
  };
});

vi.mock("../lib/AudioController", () => ({
  AudioController: { getInstance: vi.fn(() => ({ release: mocks.release })) },
}));

vi.mock("../store/playerStore", () => ({
  usePlayerStore: { getState: mocks.getState },
}));

vi.mock("../utils/driveApi", () => ({ deleteFile: mocks.deleteFile }));
vi.mock("../utils/simpleToast", () => ({
  showErrorToast: mocks.showErrorToast,
}));
vi.mock("../utils/uploadManager", () => ({
  isUploading: vi.fn(() => false),
}));
vi.mock("../utils/errorLog", () => ({ captureError: vi.fn() }));
vi.mock("../db/db", () => ({
  db: { files: { bulkDelete: mocks.bulkDelete } },
}));

import { stopPlaybackIfTrack } from "./stopPlayback";
import { useDriveBulkOps } from "../hooks/useDriveBulkOps";

beforeEach(() => {
  mocks.store.currentTrack = null;
  mocks.store.setCurrentTrack.mockClear();
  mocks.store.setIsPlaying.mockClear();
  mocks.release.mockClear();
  mocks.deleteFile.mockReset();
  mocks.showErrorToast.mockClear();
  mocks.bulkDelete.mockClear();
});

describe("stopPlaybackIfTrack", () => {
  it("releases the audio engine and clears the store when the deleted file IS the current track", () => {
    mocks.store.currentTrack = { id: "track-1" };

    stopPlaybackIfTrack("track-1");

    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.store.setCurrentTrack).toHaveBeenCalledWith(null);
    expect(mocks.store.setIsPlaying).toHaveBeenCalledWith(false);
  });

  it("is a no-op when the deleted file is NOT the current track", () => {
    mocks.store.currentTrack = { id: "track-1" };

    stopPlaybackIfTrack("other-1");

    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.store.setCurrentTrack).not.toHaveBeenCalled();
    expect(mocks.store.setIsPlaying).not.toHaveBeenCalled();
  });

  it("is a no-op when no track is loaded", () => {
    mocks.store.currentTrack = null;

    stopPlaybackIfTrack("track-1");

    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.store.setCurrentTrack).not.toHaveBeenCalled();
    expect(mocks.store.setIsPlaying).not.toHaveBeenCalled();
  });
});

describe("useDriveBulkOps.handleBulkDelete with stopPlayback", () => {
  function renderBulkDeleteHook(selectedIds: string[]) {
    const onRemoveItem = vi.fn();
    const { result } = renderHook(() =>
      useDriveBulkOps({
        token: "tok",
        currentFolderId: "folder-1",
        selectedIds: new Set(selectedIds),
        onRemoveItem,
        onRefresh: vi.fn(),
        setSelectedIds: vi.fn(),
        setIsSelectionMode: vi.fn(),
      }),
    );
    return { result, onRemoveItem };
  }

  it("bulk delete containing the playing track stops playback exactly once and deletes the other files normally", async () => {
    mocks.store.currentTrack = { id: "track-1" };
    mocks.deleteFile.mockResolvedValue({ id: "x" });
    const { result, onRemoveItem } = renderBulkDeleteHook([
      "track-1",
      "other-1",
    ]);

    await act(async () => {
      await result.current.handleBulkDelete(vi.fn());
    });

    expect(mocks.deleteFile).toHaveBeenCalledTimes(2);
    expect(mocks.deleteFile).toHaveBeenCalledWith("tok", "track-1");
    expect(mocks.deleteFile).toHaveBeenCalledWith("tok", "other-1");
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.store.setCurrentTrack).toHaveBeenCalledWith(null);
    expect(mocks.store.setIsPlaying).toHaveBeenCalledWith(false);
    expect(onRemoveItem).toHaveBeenCalledTimes(2);
    expect(mocks.bulkDelete).toHaveBeenCalledWith([
      ["default", "track-1"],
      ["default", "other-1"],
    ]);
  });

  it("bulk delete where the playing track FAILS: toast error but playback is NOT stopped", async () => {
    mocks.store.currentTrack = { id: "track-1" };
    mocks.deleteFile.mockRejectedValueOnce(new Error("network"));
    mocks.deleteFile.mockResolvedValue({ id: "x" });
    const { result } = renderBulkDeleteHook(["track-1", "other-1"]);

    await act(async () => {
      await result.current.handleBulkDelete(vi.fn());
    });

    expect(mocks.deleteFile).toHaveBeenCalledTimes(2);
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.store.setCurrentTrack).not.toHaveBeenCalled();
    expect(mocks.store.setIsPlaying).not.toHaveBeenCalled();
    expect(mocks.showErrorToast).toHaveBeenCalledTimes(1);
    expect(mocks.bulkDelete).toHaveBeenCalledWith([["default", "other-1"]]);
  });

  it("bulk delete WITHOUT the playing track never touches the player", async () => {
    mocks.store.currentTrack = { id: "track-1" };
    mocks.deleteFile.mockResolvedValue({ id: "x" });
    const { result } = renderBulkDeleteHook(["other-1", "other-2"]);

    await act(async () => {
      await result.current.handleBulkDelete(vi.fn());
    });

    expect(mocks.deleteFile).toHaveBeenCalledTimes(2);
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.store.setCurrentTrack).not.toHaveBeenCalled();
    expect(mocks.store.setIsPlaying).not.toHaveBeenCalled();
  });
});
