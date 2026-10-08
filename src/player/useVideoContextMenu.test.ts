// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlayerCommandContext } from "./commands";
import type { NativeMenuEntry } from "../lib/nativeMenu";

const eventMock = vi.hoisted(() => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: eventMock.listen }));

const modelMock = vi.hoisted(() => ({
  takeVideoMenuSnapshot: vi.fn(),
  buildContextMenuModel: vi.fn(),
  runMenuEntry: vi.fn(),
}));
vi.mock("./menuModel", () => modelMock);

const nativeMenuMock = vi.hoisted(() => ({ showContextMenu: vi.fn() }));
vi.mock("../lib/nativeMenu", () => nativeMenuMock);

const toastMock = vi.hoisted(() => ({ showErrorToast: vi.fn() }));
vi.mock("../utils/simpleToast", () => ({
  showErrorToast: toastMock.showErrorToast,
  showSuccessToast: vi.fn(),
}));

import {
  openVideoMenuSection,
  useVideoContextMenu,
} from "./useVideoContextMenu";

type MenuPayload = { x: number; y: number };
type MenuHandler = (event: { payload: MenuPayload }) => void;

let capturedHandler: MenuHandler | null = null;
const unlisten = vi.fn();

function makeCtx(isFullscreen: boolean): PlayerCommandContext {
  return {
    audio: {} as PlayerCommandContext["audio"],
    isFullscreen,
    toggleFullscreen: vi.fn(),
    toggleQueue: vi.fn(),
    isQueueOpen: false,
    selectTrack: vi.fn(),
    togglePlay: vi.fn(),
    next: vi.fn(),
    previous: vi.fn(),
    togglePlayMode: vi.fn(),
    setPlayMode: vi.fn(),
  };
}

const snapshotFixture = {
  isPaused: false,
  isFullscreen: false,
  isMuted: false,
  tracks: [],
};

const modelFixture: NativeMenuEntry[] = [
  { kind: "item", id: "PLAYER_MUTE", label: "Mute" },
];

function triggerMenu(payload: MenuPayload = { x: 10, y: 20 }): void {
  capturedHandler?.({ payload });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
}

beforeEach(() => {
  capturedHandler = null;
  unlisten.mockReset();
  eventMock.listen.mockReset();
  modelMock.takeVideoMenuSnapshot.mockReset();
  modelMock.buildContextMenuModel.mockReset();
  modelMock.runMenuEntry.mockReset();
  nativeMenuMock.showContextMenu.mockReset();
  toastMock.showErrorToast.mockReset();

  eventMock.listen.mockImplementation((_name: string, handler: MenuHandler) => {
    capturedHandler = handler;
    return Promise.resolve(unlisten);
  });
  modelMock.takeVideoMenuSnapshot.mockResolvedValue(snapshotFixture);
  modelMock.buildContextMenuModel.mockReturnValue(modelFixture);
  nativeMenuMock.showContextMenu.mockResolvedValue(null);
});

describe("useVideoContextMenu", () => {
  it("subscribes while video is active and turns an event into snapshot -> menu -> dispatch", async () => {
    const ctx = makeCtx(true);
    modelMock.takeVideoMenuSnapshot.mockResolvedValue({
      ...snapshotFixture,
      isFullscreen: true,
    });
    nativeMenuMock.showContextMenu.mockResolvedValue("PLAYER_MUTE");

    renderHook(() => {
      useVideoContextMenu({ ctx, isVideoActive: true });
    });

    await waitFor(() => {
      expect(eventMock.listen).toHaveBeenCalledWith(
        "video-context-menu",
        expect.any(Function),
      );
    });

    triggerMenu();

    await waitFor(() => {
      expect(modelMock.runMenuEntry).toHaveBeenCalledWith(
        "PLAYER_MUTE",
        ctx,
        expect.objectContaining({ isFullscreen: true }),
      );
    });
    expect(modelMock.takeVideoMenuSnapshot).toHaveBeenCalledWith(true);
    expect(modelMock.buildContextMenuModel).toHaveBeenCalledWith(
      "full",
      expect.objectContaining({ isFullscreen: true }),
    );
    expect(nativeMenuMock.showContextMenu).toHaveBeenCalledWith(modelFixture, {
      x: 10,
      y: 20,
    });
  });

  it("a dismissed menu (null) never dispatches an entry", async () => {
    nativeMenuMock.showContextMenu.mockResolvedValue(null);

    renderHook(() => {
      useVideoContextMenu({ ctx: makeCtx(false), isVideoActive: true });
    });
    await waitFor(() => {
      expect(eventMock.listen).toHaveBeenCalled();
    });

    triggerMenu({ x: 1, y: 2 });
    await waitFor(() => {
      expect(nativeMenuMock.showContextMenu).toHaveBeenCalled();
    });
    await act(flushMicrotasks);

    expect(modelMock.runMenuEntry).not.toHaveBeenCalled();
    expect(toastMock.showErrorToast).not.toHaveBeenCalled();
  });

  it("a menu failure is surfaced as an error toast, never a crash", async () => {
    nativeMenuMock.showContextMenu.mockRejectedValue(
      new Error("native menu: boom"),
    );

    renderHook(() => {
      useVideoContextMenu({ ctx: makeCtx(false), isVideoActive: true });
    });
    await waitFor(() => {
      expect(eventMock.listen).toHaveBeenCalled();
    });

    triggerMenu({ x: 1, y: 2 });

    await waitFor(() => {
      expect(toastMock.showErrorToast).toHaveBeenCalledWith(
        "native menu: boom",
      );
    });
  });

  it("a snapshot failure is surfaced as an error toast", async () => {
    modelMock.takeVideoMenuSnapshot.mockRejectedValue(
      new Error("mpvControl get speed failed"),
    );

    renderHook(() => {
      useVideoContextMenu({ ctx: makeCtx(false), isVideoActive: true });
    });
    await waitFor(() => {
      expect(eventMock.listen).toHaveBeenCalled();
    });

    triggerMenu({ x: 1, y: 2 });

    await waitFor(() => {
      expect(toastMock.showErrorToast).toHaveBeenCalledWith(
        "mpvControl get speed failed",
      );
    });
    expect(nativeMenuMock.showContextMenu).not.toHaveBeenCalled();
  });

  it("does not listen while video is inactive", () => {
    renderHook(() => {
      useVideoContextMenu({ ctx: makeCtx(false), isVideoActive: false });
    });

    expect(eventMock.listen).not.toHaveBeenCalled();
  });

  it("removes the listener when video stops being active and on unmount", async () => {
    const { rerender, unmount } = renderHook(
      ({ active }: { active: boolean }) => {
        useVideoContextMenu({ ctx: makeCtx(false), isVideoActive: active });
      },
      { initialProps: { active: true } },
    );

    await waitFor(() => {
      expect(eventMock.listen).toHaveBeenCalledTimes(1);
    });

    rerender({ active: false });
    await waitFor(() => {
      expect(unlisten).toHaveBeenCalledTimes(1);
    });

    rerender({ active: true });
    await waitFor(() => {
      expect(eventMock.listen).toHaveBeenCalledTimes(2);
    });

    unmount();
    await waitFor(() => {
      expect(unlisten).toHaveBeenCalledTimes(2);
    });
  });

  it("runs the freshest context after a rerender (ref passthrough)", async () => {
    nativeMenuMock.showContextMenu.mockResolvedValue("PLAYER_MUTE");
    const first = makeCtx(false);
    const second = makeCtx(true);

    const { rerender } = renderHook(
      ({ ctx }: { ctx: PlayerCommandContext }) => {
        useVideoContextMenu({ ctx, isVideoActive: true });
      },
      { initialProps: { ctx: first } },
    );
    await waitFor(() => {
      expect(eventMock.listen).toHaveBeenCalled();
    });

    rerender({ ctx: second });
    triggerMenu({ x: 0, y: 0 });

    await waitFor(() => {
      expect(modelMock.runMenuEntry).toHaveBeenCalledWith(
        "PLAYER_MUTE",
        second,
        expect.anything(),
      );
    });
    expect(modelMock.takeVideoMenuSnapshot).toHaveBeenCalledWith(true);
  });
});

// ---------------------------------------------------------------------------
// openVideoMenuSection (D3): the playerbar's Audio/Subtitle/More buttons open
// the SAME sections the right-click menu builds, anchored at the cursor (no
// x/y) — the hook's right-click path keeps passing the event's x/y.
// ---------------------------------------------------------------------------
describe("openVideoMenuSection", () => {
  it("opens the requested section at the cursor and dispatches the pick", async () => {
    const ctx = makeCtx(false);
    nativeMenuMock.showContextMenu.mockResolvedValue("PLAYER_MUTE");

    await openVideoMenuSection("audio", ctx, true);

    expect(modelMock.takeVideoMenuSnapshot).toHaveBeenCalledWith(true);
    expect(modelMock.buildContextMenuModel).toHaveBeenCalledWith(
      "audio",
      snapshotFixture,
    );
    // No x/y: Rust anchors the popup at the cursor (the clicked button).
    expect(nativeMenuMock.showContextMenu).toHaveBeenCalledWith(modelFixture);
    expect(modelMock.runMenuEntry).toHaveBeenCalledWith(
      "PLAYER_MUTE",
      ctx,
      snapshotFixture,
    );
  });

  it("a dismissed menu (null) never dispatches an entry", async () => {
    nativeMenuMock.showContextMenu.mockResolvedValue(null);

    await openVideoMenuSection("full", makeCtx(false), false);

    expect(modelMock.runMenuEntry).not.toHaveBeenCalled();
    expect(toastMock.showErrorToast).not.toHaveBeenCalled();
  });

  it("surfaces failures as an error toast instead of rejecting", async () => {
    nativeMenuMock.showContextMenu.mockRejectedValue(
      new Error("native menu: boom"),
    );

    await expect(
      openVideoMenuSection("audio", makeCtx(false), false),
    ).resolves.toBeUndefined();
    expect(toastMock.showErrorToast).toHaveBeenCalledWith("native menu: boom");
  });
});
