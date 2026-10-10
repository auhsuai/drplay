// @vitest-environment jsdom
/**
 * NowPlaying VISUAL POLISH (empty state / first frame / header controls).
 *
 * Three separate contracts, one file because they share the same mocks:
 *
 *  1. The video viewing area is SOLID OPAQUE BLACK until a usable frame has
 *     actually been presented, and no transparent hole is punched over the
 *     video rect before that. Without this the whole page goes transparent
 *     (`html.drplay-host-visible`) at the moment a track is SELECTED, which is
 *     long before mpv presents anything — so the shell behind the overlay
 *     (HomeTab text and thumbnails, which the transparency rules do NOT clear)
 *     shows through the empty video rect.
 *  2. The signal that ends that state is a real one-shot event from the render
 *     thread, not a timeout, and it resets per media item.
 *  3. The header chevron and the header fullscreen button are gone, the bottom
 *     bar keeps EXACTLY its control set, and NowPlaying is still exitable.
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "../../types";
import { NowPlayingView } from "./NowPlayingView";
import { NowPlayingOverlay } from "../NowPlayingOverlay";
import { useNowPlayingShortcuts } from "./hooks/useNowPlayingShortcuts";

/**
 * The Rust event name, spelled out here on purpose: this pins the WIRE contract,
 * so renaming the exported constant cannot silently break the pairing.
 */
const VIDEO_FIRST_FRAME_EVENT = "video-first-frame";

const tauriMocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriMocks.invoke }));

const eventMocks = vi.hoisted(() => ({
  listen: vi.fn(),
  unlisten: vi.fn(),
  handlers: new Map<string, Array<() => void>>(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: eventMocks.listen,
}));
eventMocks.listen.mockImplementation((name: string, handler: () => void) => {
  const list = eventMocks.handlers.get(name) ?? [];
  list.push(handler);
  eventMocks.handlers.set(name, list);
  return Promise.resolve(eventMocks.unlisten);
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const audioMock = vi.hoisted(() => {
  const handlers: Record<string, Array<(payload?: unknown) => void>> = {};
  return {
    on: vi.fn((event: string, handler: (payload?: unknown) => void) => {
      (handlers[event] ??= []).push(handler);
      return () => {
        handlers[event] = (handlers[event] ?? []).filter((h) => h !== handler);
      };
    }),
    getVolume: vi.fn(() => 0.5),
    isMuted: vi.fn(() => false),
    toggleMute: vi.fn(() => false),
    setVolume: vi.fn(),
  };
});
vi.mock("../../lib/AudioController", () => ({
  AudioController: { getInstance: () => audioMock },
}));

const storeState = vi.hoisted(() => ({
  isDownloading: false,
  errorInfo: null as { code: string; message: string } | null,
  currentTrack: null as { id: string; title: string } | null,
}));
vi.mock("../../store/playerStore", () => {
  const usePlayerStore = (selector: (s: typeof storeState) => unknown) =>
    selector(storeState);
  return {
    usePlayerStore: Object.assign(usePlayerStore, {
      getState: () => storeState,
    }),
  };
});

vi.mock("./hooks/useNowPlayingMetadata", () => ({
  useNowPlayingMetadata: () => ({
    coverUrl: null,
    setCoverUrl: vi.fn(),
    realTitle: "Title",
    realArtist: "Artist",
    bgColor: null,
    bgPalette: [],
  }),
}));
vi.mock("../components/SeekBar", () => ({
  SeekBar: () => <div data-testid="seekbar-stub" />,
}));

const VIDEO: Track = {
  id: "v",
  title: "Movie",
  artist: "",
  streamUrl: "/drive-stream/v",
  originalName: "Movie.mkv",
};
const VIDEO_2: Track = { ...VIDEO, id: "v2", originalName: "Other.MP4" };

function baseProps() {
  return {
    currentTrack: null as Track | null,
    isPlaying: false,
    onTogglePlay: vi.fn(),
    onNextTrack: vi.fn(),
    onPrevTrack: vi.fn(),
    playMode: "normal" as const,
    onTogglePlayMode: vi.fn(),
    onBack: vi.fn(),
    isOpen: true,
    token: "tok",
    isShellLocked: false,
    onToggleFullscreen: vi.fn(),
  };
}

function surfaceBox(container: HTMLElement): HTMLElement {
  const box = container.querySelector<HTMLElement>(
    "[data-testid='video-surface']",
  );
  if (!box) throw new Error("video surface not rendered");
  return box;
}

function bgLayer(container: HTMLElement): HTMLElement {
  const layer = container.querySelector<HTMLElement>(
    "[data-testid='drplay-player-bg']",
  );
  if (!layer) throw new Error("player background layer not rendered");
  return layer;
}

/** Deliver the one-shot Rust first-present event. */
async function firstFrame(): Promise<void> {
  const handlers = eventMocks.handlers.get(VIDEO_FIRST_FRAME_EVENT) ?? [];
  await act(async () => {
    await Promise.resolve();
    for (const handler of handlers) handler();
  });
}

beforeEach(() => {
  tauriMocks.invoke.mockReset();
  tauriMocks.invoke.mockResolvedValue(undefined);
  eventMocks.listen.mockClear();
  eventMocks.unlisten.mockClear();
  eventMocks.handlers.clear();
  storeState.errorInfo = null;
  storeState.currentTrack = null;
  audioMock.getVolume.mockReturnValue(0.5);
  audioMock.isMuted.mockReturnValue(false);
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// 1. Solid opaque black until a usable frame exists
// ---------------------------------------------------------------------------
describe("the video area is opaque black until a frame is presented", () => {
  it("no media at all: the empty state paints solid black", () => {
    const { container } = render(<NowPlayingView {...baseProps()} />);

    const main = container.querySelector<HTMLElement>("main");
    expect(main?.className).toContain("bg-black");
    // Nothing translucent may survive on that surface.
    expect(main?.className).not.toContain("bg-gray-100");
    expect(main?.style.background).toBe("");
  });

  it("track selected, no first frame yet: black box, NO transparent hole", () => {
    const { container } = render(
      <NowPlayingView {...baseProps()} currentTrack={VIDEO} />,
    );

    // The video rect is opaque...
    expect(surfaceBox(container).className).toContain("bg-black");
    // ...and the background layer punches no hole, so nothing behind it (the
    // shell is transparent at this point) can ever show through.
    expect(bgLayer(container).style.clipPath).toBe("");
    expect(bgLayer(container).style.clipPath).not.toContain("evenodd");
  });

  it("the first-frame event opens the hole and drops the black backdrop", async () => {
    const { container } = render(
      <NowPlayingView {...baseProps()} currentTrack={VIDEO} />,
    );
    expect(bgLayer(container).style.clipPath).toBe("");

    await firstFrame();

    expect(bgLayer(container).style.clipPath).toContain("polygon(evenodd");
    expect(surfaceBox(container).className).not.toContain("bg-black");
    // The host was already up and stays up — the signal changes the PAINT, not
    // the composition.
    expect(
      tauriMocks.invoke.mock.calls.filter(
        (call) => (call as unknown as [string])[0] === "video_host_set_visible",
      ),
    ).toHaveLength(1);
  });

  it("a media switch resets the state — the previous frame is never shown as the new item", async () => {
    const props = baseProps();
    const { container, rerender } = render(
      <NowPlayingView {...props} currentTrack={VIDEO} />,
    );
    await firstFrame();
    expect(bgLayer(container).style.clipPath).toContain("polygon(evenodd");

    storeState.currentTrack = VIDEO_2;
    rerender(<NowPlayingView {...props} currentTrack={VIDEO_2} />);

    expect(surfaceBox(container).className).toContain("bg-black");
    expect(bgLayer(container).style.clipPath).toBe("");
  });

  it("an audio track keeps its own layout: no black video box, no hole", () => {
    const { container } = render(
      <NowPlayingView
        {...baseProps()}
        currentTrack={{ id: "a", title: "S.mp3", artist: "", streamUrl: "/s" }}
      />,
    );

    expect(container.querySelector("[data-testid='video-surface']")).toBeNull();
    expect(
      container.querySelector("[data-testid='drplay-player-bg']"),
    ).toBeNull();
  });

  it("the listener is removed when the surface goes away", async () => {
    const { unmount } = render(
      <NowPlayingView {...baseProps()} currentTrack={VIDEO} />,
    );
    await firstFrame();
    unmount();
    expect(eventMocks.unlisten).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Header controls removed, bottom bar untouched, navigation not stranded
// ---------------------------------------------------------------------------
describe("header controls", () => {
  it("the video surface has no header chevron and no header fullscreen button", () => {
    const { container } = render(
      <NowPlayingView {...baseProps()} currentTrack={VIDEO} />,
    );

    expect(
      container.querySelector('button[aria-label="common.close"]'),
    ).toBeNull();
    expect(
      container.querySelector("[data-testid='fullscreen-toggle']"),
    ).toBeNull();
    expect(container.querySelectorAll(".absolute.top-6.left-6").length).toBe(0);
  });

  it("the bottom bar keeps EXACTLY its control set (nothing dropped, nothing re-added)", () => {
    const { container } = render(
      <NowPlayingView {...baseProps()} currentTrack={VIDEO} />,
    );

    const bar = container.querySelector<HTMLElement>(
      "[data-testid='video-player-bar']",
    );
    if (!bar) throw new Error("video player bar not rendered");

    const labels = [...bar.querySelectorAll("button[aria-label]")]
      .map((button) => button.getAttribute("aria-label"))
      .sort();
    expect(labels).toEqual([
      "player.fullscreen",
      "player.more",
      "player.next",
      "player.play",
      "player.play_mode",
      "player.prev",
    ]);
    // The two deleted standalone buttons must stay deleted.
    expect(labels.some((l) => /audio|subtitle/i.test(l ?? ""))).toBe(false);
    // Volume button + slider live in the bar too.
    expect(bar.querySelector('svg[class*="lucide-volume-"]')).not.toBeNull();
    expect(bar.querySelector("[data-testid='volume-bar']")).not.toBeNull();
    // The floating fullscreen control of the bar is the surviving fullscreen
    // affordance.
    expect(
      bar.querySelector('button[aria-label="player.fullscreen"]'),
    ).not.toBeNull();
  });

  it("NowPlaying is still exitable: Escape peels fullscreen then the overlay", () => {
    const onClose = vi.fn();
    const onExitFullscreen = vi.fn();

    function Harness(): ReactElement {
      const [isOpen, setIsOpen] = useState(true);
      const [isFullscreen, setIsFullscreen] = useState(true);
      useNowPlayingShortcuts({
        isOpen,
        isFullscreen,
        onClose: () => {
          onClose();
          setIsOpen(false);
        },
        onExitFullscreen: () => {
          onExitFullscreen();
          setIsFullscreen(false);
        },
      });
      return (
        <NowPlayingOverlay
          {...baseProps()}
          isOpen={isOpen}
          isFullscreen={isFullscreen}
          currentTrack={VIDEO}
          onBack={() => {
            setIsOpen(false);
          }}
        />
      );
    }

    const { container } = render(<Harness />);
    expect(
      container.querySelector('button[aria-label="common.close"]'),
    ).toBeNull();

    // From fullscreen the first Escape only leaves fullscreen...
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onExitFullscreen).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    // ...the second one leaves the overlay.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Controls hiding never touches the video geometry
// ---------------------------------------------------------------------------
describe("chrome visibility does not move the video", () => {
  it("hiding the fullscreen bar sends no new host rect", () => {
    const props = baseProps();
    const { container, rerender } = render(
      <NowPlayingView {...props} currentTrack={VIDEO} isFullscreen />,
    );
    const before = surfaceBox(container).className;
    const rectCallsBefore = tauriMocks.invoke.mock.calls.length;

    rerender(
      <NowPlayingView
        {...props}
        currentTrack={VIDEO}
        isFullscreen
        chromeVisible={false}
      />,
    );

    expect(surfaceBox(container).className).toBe(before);
    expect(tauriMocks.invoke.mock.calls.length).toBe(rectCallsBefore);
  });
});
