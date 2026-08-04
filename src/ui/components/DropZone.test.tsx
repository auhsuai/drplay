// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import {
  DropZone,
  DRAG_FOLDER_HOVER_EVENT,
  DRAG_ACTIVE_EVENT,
} from "./DropZone";
import { useDriveStore } from "../../store/driveStore";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

const mocks = vi.hoisted(() => ({
  getCurrentWebview: vi.fn(),
  onDragDropEvent: vi.fn(),
  unlisten: vi.fn(),
  statDiskPath: vi.fn(),
  startUploads: vi.fn(),
  showErrorToast: vi.fn(),
  captureError: vi.fn(),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: mocks.getCurrentWebview,
}));
vi.mock("../../utils/diskFs", () => ({ statDiskPath: mocks.statDiskPath }));
vi.mock("../../utils/uploadManager", () => ({
  startUploads: mocks.startUploads,
}));
vi.mock("../../utils/simpleToast", () => ({
  showErrorToast: mocks.showErrorToast,
}));
vi.mock("../../utils/errorLog", () => ({ captureError: mocks.captureError }));

const OVERLAY_TESTID = "drop-overlay";
const DROP_FAILED_TOAST = "upload.drop_failed";
// Rect of the fake [data-drop-region] file-list container installed by
// installDropRegion(). top=100 leaves a band above it (header/sidebar) that
// must NOT be dimmed; inside/outside decisions are made against this rect.
const REGION_RECT = { left: 0, top: 100, width: 800, height: 500 };

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

let regionElement: HTMLDivElement | null = null;

// The real app renders [data-drop-region] inside MainContent; standalone
// DropZone tests must install a stand-in so the overlay has a rect to cover.
function installDropRegion(rect: Rect = REGION_RECT): void {
  removeDropRegion();
  regionElement = document.createElement("div");
  regionElement.setAttribute("data-drop-region", "");
  Object.defineProperty(regionElement, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      ...rect,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    }),
  });
  document.body.appendChild(regionElement);
}

function removeDropRegion(): void {
  regionElement?.remove();
  regionElement = null;
}

interface DropPayload {
  type: string;
  paths?: string[];
  position?: { x: number; y: number };
}

let capturedHandler: ((event: { payload: DropPayload }) => void) | null = null;

// jsdom does not implement document.elementFromPoint at all (undefined), so
// tests install their own fake and drive it per-case (null = empty area,
// element with data-folder-id = a folder card, child span = card interior).
const elementFromPointMock = vi.fn<(x: number, y: number) => Element | null>(
  () => null,
);

function folderCardElement(id: string, returnChild = false): Element {
  const card = document.createElement("div");
  card.setAttribute("data-folder-id", id);
  const child = document.createElement("span");
  child.textContent = "card interior";
  card.appendChild(child);
  return returnChild ? child : card;
}

function hoverEvents(
  dispatchSpy: MockInstance,
): Array<{ folderId: string | null }> {
  return dispatchSpy.mock.calls
    .map((call) => call[0] as CustomEvent<{ folderId: string | null }>)
    .filter((event) => event.type === DRAG_FOLDER_HOVER_EVENT)
    .map((event) => event.detail);
}

function activeEvents(dispatchSpy: MockInstance): Array<{ active: boolean }> {
  return dispatchSpy.mock.calls
    .map((call) => call[0] as CustomEvent<{ active: boolean }>)
    .filter((event) => event.type === DRAG_ACTIVE_EVENT)
    .map((event) => event.detail);
}

function emit(event: { payload: DropPayload }): void {
  const handler = capturedHandler;
  if (!handler) throw new Error("drag-drop handler not registered");
  act(() => handler(event));
}

describe("DropZone", () => {
  beforeEach(() => {
    capturedHandler = null;
    removeDropRegion();
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      writable: true,
      value: elementFromPointMock,
    });
    elementFromPointMock.mockReset();
    elementFromPointMock.mockReturnValue(null);
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      value: 1,
    });
    mocks.getCurrentWebview.mockReset();
    mocks.onDragDropEvent.mockReset();
    mocks.unlisten.mockReset();
    mocks.statDiskPath.mockReset();
    mocks.startUploads.mockReset();
    mocks.showErrorToast.mockReset();
    mocks.captureError.mockReset();
    mocks.getCurrentWebview.mockReturnValue({
      onDragDropEvent: mocks.onDragDropEvent,
    });
    mocks.onDragDropEvent.mockImplementation(
      async (handler: (event: unknown) => void) => {
        capturedHandler = handler as (event: { payload: DropPayload }) => void;
        return mocks.unlisten;
      },
    );
    useDriveStore.setState({ currentFolderId: "root" });
  });

  afterEach(() => {
    removeDropRegion();
    cleanup();
    vi.clearAllMocks();
  });

  it("registers the drag-drop listener when a token is present and unlistens on unmount", async () => {
    const { unmount } = render(<DropZone token="tok-1" />);
    await waitFor(() => expect(mocks.onDragDropEvent).toHaveBeenCalledTimes(1));
    expect(mocks.getCurrentWebview).toHaveBeenCalledTimes(1);
    await act(async () => {});
    unmount();
    await waitFor(() => expect(mocks.unlisten).toHaveBeenCalledTimes(1));
  });

  it("does not register the listener when there is no token", () => {
    render(<DropZone token={null} />);
    expect(mocks.getCurrentWebview).not.toHaveBeenCalled();
    expect(mocks.onDragDropEvent).not.toHaveBeenCalled();
  });

  it("does not crash when getCurrentWebview throws (outside Tauri), and logs a warn", async () => {
    mocks.getCurrentWebview.mockImplementation(() => {
      throw new Error("__TAURI_INTERNALS__ is undefined");
    });
    render(<DropZone token="tok-1" />);
    await waitFor(() =>
      expect(mocks.captureError).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "DropZone",
          level: "warn",
          message: expect.stringContaining("drag-drop-listener-failed"),
        }),
      ),
    );
    expect(screen.queryByTestId(OVERLAY_TESTID)).toBeNull();
  });

  it("does not crash when onDragDropEvent rejects, and logs a warn", async () => {
    mocks.onDragDropEvent.mockRejectedValue(new Error("listen failed"));
    render(<DropZone token="tok-1" />);
    await waitFor(() =>
      expect(mocks.captureError).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "DropZone",
          level: "warn",
          message: expect.stringContaining("drag-drop-listener-failed"),
        }),
      ),
    );
    expect(screen.queryByTestId(OVERLAY_TESTID)).toBeNull();
  });

  it("guard: the dim drag overlay is gone (removed on user feedback) — drop listeners still register", async () => {
    installDropRegion();
    render(<DropZone token="tok-1" />);
    await waitFor(() => expect(capturedHandler).not.toBeNull());
    emit({ payload: { type: "over", position: { x: 100, y: 200 } } });
    // No mask may come back, with or without a drag in flight.
    expect(screen.queryByTestId(OVERLAY_TESTID)).toBeNull();
    emit({ payload: { type: "leave" } });
    expect(screen.queryByTestId(OVERLAY_TESTID)).toBeNull();
  });

  it("guard: no dim overlay on enter either (Tauri emits enter before over)", async () => {
    installDropRegion();
    render(<DropZone token="tok-1" />);
    await waitFor(() => expect(capturedHandler).not.toBeNull());
    emit({
      payload: {
        type: "enter",
        paths: ["C:\\Music\\a.mp3"],
        position: { x: 100, y: 200 },
      },
    });
    expect(screen.queryByTestId(OVERLAY_TESTID)).toBeNull();
  });

  it("guard: no overlay across repeated over events either (mask is gone entirely)", async () => {
    installDropRegion();
    render(<DropZone token="tok-1" />);
    await waitFor(() => expect(capturedHandler).not.toBeNull());
    emit({ payload: { type: "over", position: { x: 100, y: 200 } } });
    emit({ payload: { type: "over", position: { x: 110, y: 210 } } });
    expect(screen.queryByTestId(OVERLAY_TESTID)).toBeNull();
  });

  it("does NOT dim outside the drop region (sidebar/playerbar/header area): no overlay, drag still active", async () => {
    installDropRegion();
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    render(<DropZone token="tok-1" />);
    await waitFor(() => expect(capturedHandler).not.toBeNull());
    // Above the region rect (y < 100) — the header band.
    emit({ payload: { type: "over", position: { x: 10, y: 10 } } });
    expect(screen.queryByTestId(OVERLAY_TESTID)).toBeNull();
    // Right of the region rect (x > 800) — the sidebar-adjacent band.
    emit({ payload: { type: "over", position: { x: 900, y: 200 } } });
    expect(screen.queryByTestId(OVERLAY_TESTID)).toBeNull();
    expect(activeEvents(dispatchSpy)).toEqual([
      { active: true },
      { active: true },
    ]);
  });

  it("no [data-drop-region] in the DOM (e.g. Home tab) → no overlay, but folder hit-test + drag-active still work", async () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    elementFromPointMock.mockReturnValue(folderCardElement("folder-1"));
    render(<DropZone token="tok-1" />);
    await waitFor(() => expect(capturedHandler).not.toBeNull());
    emit({ payload: { type: "over", position: { x: 10, y: 200 } } });
    expect(hoverEvents(dispatchSpy)).toEqual([{ folderId: "folder-1" }]);
    expect(activeEvents(dispatchSpy)).toEqual([{ active: true }]);
    expect(screen.queryByTestId(OVERLAY_TESTID)).toBeNull();
    // Empty area without a region: still no overlay, still active.
    elementFromPointMock.mockReturnValue(null);
    emit({ payload: { type: "over", position: { x: 20, y: 210 } } });
    expect(screen.queryByTestId(OVERLAY_TESTID)).toBeNull();
    expect(activeEvents(dispatchSpy)).toEqual([
      { active: true },
      { active: true },
    ]);
  });

  it("announces drag-active=true on enter/over (even over a folder) and false on leave", async () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    elementFromPointMock.mockReturnValue(folderCardElement("folder-1"));
    render(<DropZone token="tok-1" />);
    await waitFor(() => expect(capturedHandler).not.toBeNull());
    emit({
      payload: { type: "enter", paths: [], position: { x: 10, y: 200 } },
    });
    emit({ payload: { type: "over", position: { x: 10, y: 200 } } });
    emit({ payload: { type: "leave" } });
    expect(activeEvents(dispatchSpy)).toEqual([
      { active: true },
      { active: true },
      { active: false },
    ]);
  });

  it("announces drag-active=false on drop (header/pagination reappear)", async () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    mocks.statDiskPath.mockResolvedValue({
      path: "C:\\Music\\a.mp3",
      name: "a.mp3",
      relativePath: "a.mp3",
      isDirectory: false,
      size: 10,
    });
    render(<DropZone token="tok-1" />);
    await waitFor(() => expect(capturedHandler).not.toBeNull());
    emit({ payload: { type: "over", position: { x: 10, y: 200 } } });
    emit({
      payload: {
        type: "drop",
        paths: ["C:\\Music\\a.mp3"],
        position: { x: 10, y: 200 },
      },
    });
    await waitFor(() => expect(mocks.startUploads).toHaveBeenCalledTimes(1));
    expect(activeEvents(dispatchSpy)).toEqual([
      { active: true },
      { active: false },
    ]);
  });

  it("resolves the nearest folder from the ±8px probe grid when the cursor sits in the padding gap", async () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    // Cursor in the 12px gap between cards: the center probe misses, the
    // +8px vertical probe lands on the card below the gap.
    elementFromPointMock.mockImplementation((_x: number, y: number) => {
      if (y === 208) return folderCardElement("folder-gap");
      return null;
    });
    render(<DropZone token="tok-1" />);
    await waitFor(() => expect(capturedHandler).not.toBeNull());
    emit({ payload: { type: "over", position: { x: 100, y: 200 } } });
    expect(hoverEvents(dispatchSpy)).toEqual([{ folderId: "folder-gap" }]);
    expect(screen.queryByTestId(OVERLAY_TESTID)).toBeNull();
  });

  it("hides the overlay and announces the folder when over a folder card", async () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    elementFromPointMock.mockReturnValue(folderCardElement("folder-1"));
    render(<DropZone token="tok-1" />);
    await waitFor(() => expect(capturedHandler).not.toBeNull());
    emit({ payload: { type: "over", position: { x: 10, y: 20 } } });
    expect(screen.queryByTestId(OVERLAY_TESTID)).toBeNull();
    expect(hoverEvents(dispatchSpy)).toEqual([{ folderId: "folder-1" }]);
  });

  it("resolves the folder even when elementFromPoint returns a child of the card (closest() hit-test)", async () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    elementFromPointMock.mockReturnValue(folderCardElement("folder-1", true));
    render(<DropZone token="tok-1" />);
    await waitFor(() => expect(capturedHandler).not.toBeNull());
    emit({ payload: { type: "over", position: { x: 10, y: 20 } } });
    expect(hoverEvents(dispatchSpy)).toEqual([{ folderId: "folder-1" }]);
  });

  it("converts the physical drag position to CSS px via devicePixelRatio before hit-testing (probe grid too)", async () => {
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      value: 2,
    });
    render(<DropZone token="tok-1" />);
    await waitFor(() => expect(capturedHandler).not.toBeNull());
    emit({ payload: { type: "over", position: { x: 200, y: 400 } } });
    expect(elementFromPointMock).toHaveBeenCalledWith(100, 200);
    // ±8px offsets are applied in CSS px AFTER the dpr conversion.
    expect(elementFromPointMock).toHaveBeenCalledWith(100, 208);
    expect(elementFromPointMock).toHaveBeenCalledWith(108, 200);
  });

  it("guard: folder hover vs region switching works without any dim overlay", async () => {
    installDropRegion();
    elementFromPointMock.mockReturnValue(folderCardElement("folder-1"));
    render(<DropZone token="tok-1" />);
    await waitFor(() => expect(capturedHandler).not.toBeNull());
    emit({ payload: { type: "over", position: { x: 100, y: 200 } } });
    expect(screen.queryByTestId(OVERLAY_TESTID)).toBeNull();
    elementFromPointMock.mockReturnValue(null);
    emit({ payload: { type: "over", position: { x: 110, y: 210 } } });
    expect(screen.queryByTestId(OVERLAY_TESTID)).toBeNull();
    elementFromPointMock.mockReturnValue(folderCardElement("folder-1"));
    emit({ payload: { type: "over", position: { x: 120, y: 220 } } });
    expect(screen.queryByTestId(OVERLAY_TESTID)).toBeNull();
  });

  it("stays stable across repeated over events on the same folder (same hover id, no flicker)", async () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    elementFromPointMock.mockReturnValue(folderCardElement("folder-1"));
    render(<DropZone token="tok-1" />);
    await waitFor(() => expect(capturedHandler).not.toBeNull());
    emit({ payload: { type: "over", position: { x: 1, y: 1 } } });
    emit({ payload: { type: "over", position: { x: 2, y: 2 } } });
    expect(screen.queryByTestId(OVERLAY_TESTID)).toBeNull();
    expect(hoverEvents(dispatchSpy)).toEqual([
      { folderId: "folder-1" },
      { folderId: "folder-1" },
    ]);
  });

  it("leave clears both the overlay and the folder hover announcement", async () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    elementFromPointMock.mockReturnValue(folderCardElement("folder-1"));
    render(<DropZone token="tok-1" />);
    await waitFor(() => expect(capturedHandler).not.toBeNull());
    emit({ payload: { type: "over", position: { x: 1, y: 1 } } });
    emit({ payload: { type: "leave" } });
    expect(screen.queryByTestId(OVERLAY_TESTID)).toBeNull();
    expect(hoverEvents(dispatchSpy)).toEqual([
      { folderId: "folder-1" },
      { folderId: null },
    ]);
  });

  it("drop clears the folder hover (announce null) even when dropping outside any folder", async () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    mocks.statDiskPath.mockResolvedValue({
      path: "C:\\Music\\a.mp3",
      name: "a.mp3",
      relativePath: "a.mp3",
      isDirectory: false,
      size: 10,
    });
    elementFromPointMock.mockReturnValue(folderCardElement("folder-1"));
    render(<DropZone token="tok-1" />);
    await waitFor(() => expect(capturedHandler).not.toBeNull());
    emit({ payload: { type: "over", position: { x: 1, y: 1 } } });
    elementFromPointMock.mockReturnValue(null);
    emit({
      payload: {
        type: "drop",
        paths: ["C:\\Music\\a.mp3"],
        position: { x: 50, y: 60 },
      },
    });
    await waitFor(() => expect(mocks.startUploads).toHaveBeenCalledTimes(1));
    expect(hoverEvents(dispatchSpy)).toEqual([
      { folderId: "folder-1" },
      { folderId: null },
    ]);
  });

  it("uploads a dropped file into the current folder", async () => {
    useDriveStore.setState({ currentFolderId: "folder-1" });
    mocks.statDiskPath.mockResolvedValue({
      path: "C:\\Music\\a.mp3",
      name: "a.mp3",
      relativePath: "a.mp3",
      isDirectory: false,
      size: 10,
    });
    render(<DropZone token="tok-1" />);
    await waitFor(() => expect(capturedHandler).not.toBeNull());
    emit({
      payload: {
        type: "drop",
        paths: ["C:\\Music\\a.mp3"],
        position: { x: 1, y: 1 },
      },
    });
    await waitFor(() => expect(mocks.startUploads).toHaveBeenCalledTimes(1));
    expect(mocks.startUploads).toHaveBeenCalledWith(
      [
        {
          name: "a.mp3",
          isFolder: false,
          parentId: "folder-1",
          diskPath: "C:\\Music\\a.mp3",
        },
      ],
      "tok-1",
    );
    expect(screen.queryByTestId(OVERLAY_TESTID)).toBeNull();
  });

  it("uploads into the hovered folder when dropping on a folder card (parentId = that folder, not currentFolderId)", async () => {
    useDriveStore.setState({ currentFolderId: "root" });
    mocks.statDiskPath.mockResolvedValue({
      path: "C:\\Music\\a.mp3",
      name: "a.mp3",
      relativePath: "a.mp3",
      isDirectory: false,
      size: 10,
    });
    elementFromPointMock.mockReturnValue(folderCardElement("folder-9"));
    render(<DropZone token="tok-1" />);
    await waitFor(() => expect(capturedHandler).not.toBeNull());
    emit({
      payload: {
        type: "drop",
        paths: ["C:\\Music\\a.mp3"],
        position: { x: 1, y: 1 },
      },
    });
    await waitFor(() => expect(mocks.startUploads).toHaveBeenCalledTimes(1));
    expect(mocks.startUploads).toHaveBeenCalledWith(
      [
        {
          name: "a.mp3",
          isFolder: false,
          parentId: "folder-9",
          diskPath: "C:\\Music\\a.mp3",
        },
      ],
      "tok-1",
    );
  });

  it("falls back to the current folder when the drop payload has no position", async () => {
    useDriveStore.setState({ currentFolderId: "folder-1" });
    mocks.statDiskPath.mockResolvedValue({
      path: "C:\\Music\\a.mp3",
      name: "a.mp3",
      relativePath: "a.mp3",
      isDirectory: false,
      size: 10,
    });
    render(<DropZone token="tok-1" />);
    await waitFor(() => expect(capturedHandler).not.toBeNull());
    emit({ payload: { type: "drop", paths: ["C:\\Music\\a.mp3"] } });
    await waitFor(() => expect(mocks.startUploads).toHaveBeenCalledTimes(1));
    expect(mocks.startUploads).toHaveBeenCalledWith(
      [
        {
          name: "a.mp3",
          isFolder: false,
          parentId: "folder-1",
          diskPath: "C:\\Music\\a.mp3",
        },
      ],
      "tok-1",
    );
  });

  it("uploads a dropped folder with isFolder true", async () => {
    mocks.statDiskPath.mockResolvedValue({
      path: "C:\\Music\\Album",
      name: "Album",
      relativePath: "Album",
      isDirectory: true,
      size: 0,
    });
    render(<DropZone token="tok-1" />);
    await waitFor(() => expect(capturedHandler).not.toBeNull());
    emit({
      payload: {
        type: "drop",
        paths: ["C:\\Music\\Album"],
        position: { x: 1, y: 1 },
      },
    });
    await waitFor(() => expect(mocks.startUploads).toHaveBeenCalledTimes(1));
    expect(mocks.startUploads).toHaveBeenCalledWith(
      [
        {
          name: "Album",
          isFolder: true,
          parentId: "root",
          diskPath: "C:\\Music\\Album",
        },
      ],
      "tok-1",
    );
  });

  it("groups a mixed drop (file + folder) into a single startUploads call", async () => {
    mocks.statDiskPath.mockImplementation(async (path: string) => ({
      path,
      name: path.endsWith("Album") ? "Album" : "a.mp3",
      relativePath: path.endsWith("Album") ? "Album" : "a.mp3",
      isDirectory: path.endsWith("Album"),
      size: path.endsWith("Album") ? 0 : 1,
    }));
    render(<DropZone token="tok-1" />);
    await waitFor(() => expect(capturedHandler).not.toBeNull());
    emit({
      payload: {
        type: "drop",
        paths: ["C:\\Music\\a.mp3", "C:\\Music\\Album"],
        position: { x: 1, y: 1 },
      },
    });
    await waitFor(() => expect(mocks.startUploads).toHaveBeenCalledTimes(1));
    expect(mocks.startUploads).toHaveBeenCalledWith(
      [
        {
          name: "a.mp3",
          isFolder: false,
          parentId: "root",
          diskPath: "C:\\Music\\a.mp3",
        },
        {
          name: "Album",
          isFolder: true,
          parentId: "root",
          diskPath: "C:\\Music\\Album",
        },
      ],
      "tok-1",
    );
  });

  it("skips not-found paths and toasts when every dropped path is invalid", async () => {
    mocks.statDiskPath.mockResolvedValue(null);
    render(<DropZone token="tok-1" />);
    await waitFor(() => expect(capturedHandler).not.toBeNull());
    emit({
      payload: {
        type: "drop",
        paths: ["C:\\gone\\x.mp3", "C:\\gone\\album"],
        position: { x: 1, y: 1 },
      },
    });
    await waitFor(() =>
      expect(mocks.showErrorToast).toHaveBeenCalledWith(DROP_FAILED_TOAST),
    );
    expect(mocks.startUploads).not.toHaveBeenCalled();
    expect(mocks.captureError).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "DropZone",
        level: "warn",
        message: expect.stringContaining("drop-path-missing"),
      }),
    );
  });

  it("skips a stat-failing path but still uploads the valid ones (no throw)", async () => {
    mocks.statDiskPath.mockImplementation(async (path: string) => {
      if (path.includes("bad")) throw new Error("permission denied");
      return {
        path,
        name: "ok.mp3",
        relativePath: "ok.mp3",
        isDirectory: false,
        size: 1,
      };
    });
    render(<DropZone token="tok-1" />);
    await waitFor(() => expect(capturedHandler).not.toBeNull());
    emit({
      payload: {
        type: "drop",
        paths: ["C:\\bad\\x.mp3", "C:\\ok\\ok.mp3"],
        position: { x: 1, y: 1 },
      },
    });
    await waitFor(() => expect(mocks.startUploads).toHaveBeenCalledTimes(1));
    expect(mocks.startUploads).toHaveBeenCalledWith(
      [
        {
          name: "ok.mp3",
          isFolder: false,
          parentId: "root",
          diskPath: "C:\\ok\\ok.mp3",
        },
      ],
      "tok-1",
    );
    expect(mocks.captureError).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "DropZone",
        level: "warn",
        message: expect.stringContaining("drop-stat-failed"),
      }),
    );
  });

  it("does nothing when the drop payload has no paths", async () => {
    render(<DropZone token="tok-1" />);
    await waitFor(() => expect(capturedHandler).not.toBeNull());
    emit({ payload: { type: "drop", paths: [], position: { x: 1, y: 1 } } });
    expect(mocks.statDiskPath).not.toHaveBeenCalled();
    expect(mocks.startUploads).not.toHaveBeenCalled();
    expect(mocks.showErrorToast).not.toHaveBeenCalled();
  });

  it("handles a drop without a preceding over (overlay hides, upload proceeds)", async () => {
    mocks.statDiskPath.mockResolvedValue({
      path: "C:\\Music\\b.mp3",
      name: "b.mp3",
      relativePath: "b.mp3",
      isDirectory: false,
      size: 2,
    });
    render(<DropZone token="tok-1" />);
    await waitFor(() => expect(capturedHandler).not.toBeNull());
    emit({
      payload: {
        type: "drop",
        paths: ["C:\\Music\\b.mp3"],
        position: { x: 1, y: 1 },
      },
    });
    await waitFor(() => expect(mocks.startUploads).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId(OVERLAY_TESTID)).toBeNull();
  });

  it("does not upload when the token is gone at drop time", async () => {
    mocks.statDiskPath.mockResolvedValue({
      path: "C:\\Music\\c.mp3",
      name: "c.mp3",
      relativePath: "c.mp3",
      isDirectory: false,
      size: 3,
    });
    const { rerender } = render(<DropZone token="tok-1" />);
    await waitFor(() => expect(capturedHandler).not.toBeNull());
    rerender(<DropZone token={null} />);
    emit({
      payload: {
        type: "drop",
        paths: ["C:\\Music\\c.mp3"],
        position: { x: 1, y: 1 },
      },
    });
    expect(mocks.statDiskPath).not.toHaveBeenCalled();
    expect(mocks.startUploads).not.toHaveBeenCalled();
  });
});
