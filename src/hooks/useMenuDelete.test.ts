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

beforeEach(() => {
  vi.clearAllMocks();
  deleteFileMock.mockResolvedValue(undefined);
  dbMock.files.delete.mockResolvedValue(undefined);
});

describe("useMenuDelete double-click race guard", () => {
  it("invokes deleteFile exactly once when Confirm fires twice in the same tick", async () => {
    const { result } = renderHook(() => useMenuDelete(t));
    act(() => {
      result.current.openDeleteConfirm(makeItem());
    });

    // Keep the first delete in flight so the second synchronous call hits
    // the busy-guard while deleteFile has not resolved yet (real
    // double-click: both clicks land before React re-renders).
    let resolveDelete!: () => void;
    deleteFileMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve;
        }),
    );

    const calls: Array<Promise<void>> = [];
    act(() => {
      calls.push(result.current.handleDelete("tok", vi.fn()));
      calls.push(result.current.handleDelete("tok", vi.fn()));
    });

    // Flush microtasks so both invocations reach their deleteFile call.
    await act(async () => {});

    expect(deleteFileMock).toHaveBeenCalledTimes(1);

    resolveDelete();
    await Promise.all(calls);
  });

  it("allows a retry after a failed delete resets the busy-guard in finally", async () => {
    const { result } = renderHook(() => useMenuDelete(t));
    act(() => {
      result.current.openDeleteConfirm(makeItem());
    });

    deleteFileMock
      .mockRejectedValueOnce(new Error("HTTP 404"))
      .mockResolvedValueOnce(undefined);

    // First attempt fails: error toast, dialog stays open.
    await act(async () => {
      await result.current.handleDelete("tok", vi.fn());
    });
    expect(showErrorToastMock).toHaveBeenCalledWith("drive.delete_error");

    // Retry after the failure must go through (busy-guard was reset).
    await act(async () => {
      await result.current.handleDelete("tok", vi.fn());
    });

    expect(deleteFileMock).toHaveBeenCalledTimes(2);
    expect(stopPlaybackIfTrackMock).toHaveBeenCalledTimes(1);
  });
});
