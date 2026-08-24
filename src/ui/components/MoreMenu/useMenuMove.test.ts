// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DriveItem } from "../../../types";

const moveFileMock = vi.hoisted(() => vi.fn());
vi.mock("../../../utils/driveApi", () => ({ moveFile: moveFileMock }));

const dbMock = vi.hoisted(() => ({
  files: { update: vi.fn() },
}));
vi.mock("../../../db/db", () => ({ db: dbMock }));

const captureErrorMock = vi.hoisted(() => vi.fn());
vi.mock("../../../utils/errorLog", () => ({ captureError: captureErrorMock }));

const showErrorToastMock = vi.hoisted(() => vi.fn());
vi.mock("../../../utils/simpleToast", () => ({
  showErrorToast: showErrorToastMock,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { useMenuMove } from "./useMenuMove";

function makeItem(overrides: Partial<DriveItem> = {}): DriveItem {
  return { id: "file-1", title: "Song", isFolder: false, ...overrides };
}

function renderMove(overrides: {
  driveItem?: DriveItem;
  onRemoveItem?: (id: string) => void;
  onRefresh?: () => void;
}) {
  const setIsOpen = vi.fn();
  const onClose = vi.fn();
  const { result } = renderHook(() =>
    useMenuMove({
      driveItem: makeItem(),
      token: "tok",
      currentFolderId: "root",
      setIsOpen,
      onClose,
      ...overrides,
    }),
  );
  return { result, setIsOpen, onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
  moveFileMock.mockResolvedValue(undefined);
  dbMock.files.update.mockResolvedValue(1);
});

describe("useMenuMove happy path", () => {
  it("moves remotely then updates local cache and removes the item from view", async () => {
    const onRemoveItem = vi.fn();
    const onRefresh = vi.fn();
    const { result } = renderMove({ onRemoveItem, onRefresh });

    await act(async () => {
      await result.current.handleMove("folder-b");
    });

    expect(moveFileMock).toHaveBeenCalledWith(
      "tok",
      "file-1",
      "root",
      "folder-b",
    );
    expect(dbMock.files.update).toHaveBeenCalledWith(["default", "file-1"], {
      parentId: "folder-b",
    });
    expect(onRemoveItem).toHaveBeenCalledWith("file-1");
    expect(showErrorToastMock).not.toHaveBeenCalled();
    expect(captureErrorMock).not.toHaveBeenCalled();
  });
});

describe("useMenuMove partial failure (remote OK, local Dexie fail)", () => {
  it("does NOT surface a move_error toast when only the local cache update fails (no onRemoveItem → refresh)", async () => {
    moveFileMock.mockResolvedValue(undefined);
    dbMock.files.update.mockRejectedValue(new Error("dexie down"));
    const onRefresh = vi.fn();
    const { result } = renderMove({ onRefresh });

    await act(async () => {
      await result.current.handleMove("folder-b");
    });

    // Remote truth: the move succeeded — no user-facing error.
    expect(showErrorToastMock).not.toHaveBeenCalled();
    // Local-only failure is logged as warn, not error.
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warn", source: "MoreMenu" }),
    );
    // UI still reflects remote truth like the success path.
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("still calls onRemoveItem when provided even if the local cache update fails", async () => {
    moveFileMock.mockResolvedValue(undefined);
    dbMock.files.update.mockRejectedValue(new Error("dexie down"));
    const onRemoveItem = vi.fn();
    const { result } = renderMove({ onRemoveItem });

    await act(async () => {
      await result.current.handleMove("folder-b");
    });

    expect(showErrorToastMock).not.toHaveBeenCalled();
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warn" }),
    );
    expect(onRemoveItem).toHaveBeenCalledWith("file-1");
  });
});

describe("useMenuMove remote failure (unchanged behavior)", () => {
  it("shows move_error, logs error and refreshes when the Drive move itself fails", async () => {
    moveFileMock.mockRejectedValue(new Error("HTTP 500"));
    const onRefresh = vi.fn();
    const { result } = renderMove({ onRefresh });

    await act(async () => {
      await result.current.handleMove("folder-b");
    });

    expect(showErrorToastMock).toHaveBeenCalledWith("drive.move_error");
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ level: "error" }),
    );
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(dbMock.files.update).not.toHaveBeenCalled();
  });
});
