// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MouseEvent } from "react";
import type { TFunction } from "i18next";
import type { DriveItem, Track } from "../types";
import { useMenuAddToQueue } from "./useMenuAddToQueue";

const appendTracksToQueueMock = vi.hoisted(() => vi.fn());
vi.mock("../store/queueOps", () => ({
  appendTracksToQueue: appendTracksToQueueMock,
}));

const collectFolderTracksMock = vi.hoisted(() => vi.fn());
vi.mock("../utils/folderTracks", () => ({
  collectFolderTracks: collectFolderTracksMock,
  MAX_ADD_TO_QUEUE_TRACKS: 1000,
}));

const showSuccessToastMock = vi.hoisted(() => vi.fn());
const showErrorToastMock = vi.hoisted(() => vi.fn());
vi.mock("../utils/simpleToast", () => ({
  showSuccessToast: showSuccessToastMock,
  showErrorToast: showErrorToastMock,
}));

const captureErrorMock = vi.hoisted(() => vi.fn());
vi.mock("../utils/errorLog", () => ({ captureError: captureErrorMock }));

// Encodes both the key and the count option so assertions prove the plural
// call shape without depending on i18next runtime plumbing.
const t = ((key: string, options?: { count?: number }) =>
  options?.count === undefined
    ? key
    : `${key}#${String(options.count)}`) as unknown as TFunction;

const folderItem: DriveItem = {
  id: "folder-1",
  title: "Folder One",
  isFolder: true,
};

const fileItem: DriveItem = {
  id: "file-1",
  title: "Song One",
  isFolder: false,
};

function makeTrack(id: string): Track {
  return { id, title: id, artist: "", streamUrl: "" };
}

function clickEvent(): {
  event: MouseEvent;
  stopPropagation: ReturnType<typeof vi.fn>;
} {
  const stopPropagation = vi.fn();
  return {
    event: { stopPropagation } as unknown as MouseEvent,
    stopPropagation,
  };
}

const collected = (tracks: Track[], truncated = false) => ({
  tracks,
  truncated,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useMenuAddToQueue", () => {
  it("appends a single track and closes the menu on file click", () => {
    const { result } = renderHook(() => useMenuAddToQueue(t));
    const setIsOpen = vi.fn();
    const onClose = vi.fn();
    const { event, stopPropagation } = clickEvent();

    act(() => {
      result.current.handleAddToQueueClick(
        event,
        fileItem,
        makeTrack("t1"),
        "tok",
        setIsOpen,
        onClose,
      );
    });

    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(appendTracksToQueueMock).toHaveBeenCalledWith([makeTrack("t1")]);
    expect(showSuccessToastMock).toHaveBeenCalledWith("queue.added_toast#1");
    expect(setIsOpen).toHaveBeenCalledWith(false);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(collectFolderTracksMock).not.toHaveBeenCalled();
  });

  it("collects a folder recursively, appends the tracks and toggles the busy flag", async () => {
    let resolveCollect:
      ((value: { tracks: Track[]; truncated: boolean }) => void) | undefined;
    collectFolderTracksMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCollect = resolve;
        }),
    );
    const { result } = renderHook(() => useMenuAddToQueue(t));
    const setIsOpen = vi.fn();
    const onClose = vi.fn();
    const tracks = [makeTrack("a"), makeTrack("b")];

    act(() => {
      result.current.handleAddToQueueClick(
        clickEvent().event,
        folderItem,
        undefined,
        "tok",
        setIsOpen,
        onClose,
      );
    });

    expect(result.current.isAddingToQueue).toBe(true);
    expect(setIsOpen).toHaveBeenCalledWith(false);
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => {
      resolveCollect?.(collected(tracks));
    });
    await act(async () => {});

    expect(collectFolderTracksMock).toHaveBeenCalledWith(
      "tok",
      "folder-1",
      "Folder One",
      expect.any(AbortSignal),
    );
    expect(appendTracksToQueueMock).toHaveBeenCalledWith(tracks);
    expect(showSuccessToastMock).toHaveBeenCalledWith("queue.added_toast#2");
    expect(showErrorToastMock).not.toHaveBeenCalled();
    expect(result.current.isAddingToQueue).toBe(false);
  });

  it("reports an empty folder instead of appending nothing", async () => {
    collectFolderTracksMock.mockResolvedValue(collected([]));
    const { result } = renderHook(() => useMenuAddToQueue(t));

    act(() => {
      result.current.handleAddToQueueClick(
        clickEvent().event,
        folderItem,
        undefined,
        "tok",
        vi.fn(),
      );
    });
    await act(async () => {});

    expect(appendTracksToQueueMock).not.toHaveBeenCalled();
    expect(showErrorToastMock).toHaveBeenCalledWith("queue.add_empty");
    expect(showSuccessToastMock).not.toHaveBeenCalled();
  });

  it("reports truncation as a single merged toast after a capped append", async () => {
    collectFolderTracksMock.mockResolvedValue(
      collected([makeTrack("a")], true),
    );
    const { result } = renderHook(() => useMenuAddToQueue(t));

    act(() => {
      result.current.handleAddToQueueClick(
        clickEvent().event,
        folderItem,
        undefined,
        "tok",
        vi.fn(),
      );
    });
    await act(async () => {});

    expect(appendTracksToQueueMock).toHaveBeenCalledTimes(1);
    // simpleToast shows at most ONE toast: a separate success toast would be
    // wiped by the truncation toast in the same tick, so both infos (added
    // count + cap reason) are merged into a single toast.
    expect(showSuccessToastMock).not.toHaveBeenCalled();
    expect(showErrorToastMock).toHaveBeenCalledTimes(1);
    expect(showErrorToastMock).toHaveBeenCalledWith(
      "queue.added_toast#1. queue.add_truncated#1000",
    );
  });

  it("stays silent on abort: no toasts, no error log", async () => {
    collectFolderTracksMock.mockRejectedValue(
      new DOMException("aborted", "AbortError"),
    );
    const { result } = renderHook(() => useMenuAddToQueue(t));

    act(() => {
      result.current.handleAddToQueueClick(
        clickEvent().event,
        folderItem,
        undefined,
        "tok",
        vi.fn(),
      );
    });
    await act(async () => {});

    expect(showSuccessToastMock).not.toHaveBeenCalled();
    expect(showErrorToastMock).not.toHaveBeenCalled();
    expect(captureErrorMock).not.toHaveBeenCalled();
    expect(result.current.isAddingToQueue).toBe(false);
  });

  it("logs and toasts on a non-abort failure", async () => {
    collectFolderTracksMock.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useMenuAddToQueue(t));

    act(() => {
      result.current.handleAddToQueueClick(
        clickEvent().event,
        folderItem,
        undefined,
        "tok",
        vi.fn(),
      );
    });
    await act(async () => {});

    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        source: "useMenuAddToQueue",
        message: expect.stringContaining(
          "add-to-queue-failed: boom",
        ) as unknown as string,
      }),
    );
    expect(showErrorToastMock).toHaveBeenCalledWith("queue.add_failed");
    expect(appendTracksToQueueMock).not.toHaveBeenCalled();
  });

  it("is a no-op for a folder without a token", () => {
    const { result } = renderHook(() => useMenuAddToQueue(t));
    const setIsOpen = vi.fn();
    const onClose = vi.fn();
    const { event, stopPropagation } = clickEvent();

    act(() => {
      result.current.handleAddToQueueClick(
        event,
        folderItem,
        undefined,
        null,
        setIsOpen,
        onClose,
      );
    });

    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(collectFolderTracksMock).not.toHaveBeenCalled();
    expect(appendTracksToQueueMock).not.toHaveBeenCalled();
    expect(showSuccessToastMock).not.toHaveBeenCalled();
    expect(showErrorToastMock).not.toHaveBeenCalled();
    expect(setIsOpen).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("ignores a second folder click while the first walk is still running", async () => {
    let resolveCollect:
      ((value: { tracks: Track[]; truncated: boolean }) => void) | undefined;
    collectFolderTracksMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCollect = resolve;
        }),
    );
    const { result } = renderHook(() => useMenuAddToQueue(t));

    act(() => {
      result.current.handleAddToQueueClick(
        clickEvent().event,
        folderItem,
        undefined,
        "tok",
        vi.fn(),
      );
      result.current.handleAddToQueueClick(
        clickEvent().event,
        folderItem,
        undefined,
        "tok",
        vi.fn(),
      );
    });
    await act(async () => {});

    expect(collectFolderTracksMock).toHaveBeenCalledTimes(1);

    act(() => {
      resolveCollect?.(collected([makeTrack("a")]));
    });
    await act(async () => {});
  });

  it("aborts the in-flight walk on unmount without surfacing anything", async () => {
    let capturedSignal: AbortSignal | undefined;
    let resolveCollect:
      ((value: { tracks: Track[]; truncated: boolean }) => void) | undefined;
    collectFolderTracksMock.mockImplementation(
      (_token: string, _id: string, _name: string, signal?: AbortSignal) => {
        capturedSignal = signal;
        return new Promise((resolve) => {
          resolveCollect = resolve;
        });
      },
    );
    const { result, unmount } = renderHook(() => useMenuAddToQueue(t));

    act(() => {
      result.current.handleAddToQueueClick(
        clickEvent().event,
        folderItem,
        undefined,
        "tok",
        vi.fn(),
      );
    });
    expect(capturedSignal?.aborted).toBe(false);

    unmount();
    expect(capturedSignal?.aborted).toBe(true);

    act(() => {
      resolveCollect?.(collected([]));
    });
    await act(async () => {});
    expect(showErrorToastMock).not.toHaveBeenCalled();
    expect(showSuccessToastMock).not.toHaveBeenCalled();
  });
});
