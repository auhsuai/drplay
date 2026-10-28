// @vitest-environment jsdom
/**
 * Now Playing with an ACTIVE Picture-in-Picture window.
 *
 * Why this file exists: the PiP window owns the native video surface. If the
 * main window kept rendering its own `VideoSurface` while PiP is up, that
 * component would toggle `html.drplay-host-visible` (it has no owner guard on
 * the root class), and App.css turns `aside` + `#content-area` invisible under
 * that class â€” the shell would ghost out underneath an overlay that is
 * supposed to be a plain placeholder. The view must therefore paint a black
 * placeholder INSTEAD of the surface, and must not punch the host hole in its
 * background layer (the host is not in this window any more).
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "../../types";
import en from "../../locales/en/translation.json";
import viLocale from "../../locales/vi/translation.json";
import { NowPlayingView } from "./NowPlayingView";

const PIP_TEXT_KEY = "player.pip.playing_in_pip";

const tauriMocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriMocks.invoke }));

const eventMocks = vi.hoisted(() => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  handlers: [] as Array<() => void>,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: () => void) => {
    if (name === "video-first-frame") eventMocks.handlers.push(handler);
    return eventMocks.listen();
  },
}));

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
    _emit(event: string, payload?: unknown) {
      for (const h of handlers[event] ?? []) h(payload);
    },
    getCurrentTime: vi.fn(() => 0),
    getDuration: vi.fn(() => 0),
    getCurrentTrackId: vi.fn<() => string | null>(() => null),
    playTrack: vi.fn(() => Promise.resolve()),
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

// The real surface owns the native host IPC and would flood the assertions
// with calls; its presence is the ONLY thing under test here, so a stand-in
// that keeps the production test id is enough.
vi.mock("./components/VideoSurface", () => ({
  VideoSurface: () => <div data-testid="video-surface" />,
  VIDEO_HOST_OWNER_CHANGED_EVENT: "drplay:video-host-owner-changed",
}));

const VIDEO: Track = {
  id: "v",
  title: "Movie",
  artist: "",
  streamUrl: "/drive-stream/v",
  originalName: "Movie.mkv",
};
const AUDIO: Track = {
  id: "a",
  title: "Song.mp3",
  artist: "",
  streamUrl: "/drive-stream/a",
};

type Props = Parameters<typeof NowPlayingView>[0];

function baseProps(): Props {
  return {
    currentTrack: null,
    isPlaying: false,
    onTogglePlay: vi.fn(),
    onNextTrack: vi.fn(),
    onPrevTrack: vi.fn(),
    playMode: "normal",
    onTogglePlayMode: vi.fn(),
    onBack: vi.fn(),
    isOpen: true,
    token: "tok",
    isShellLocked: false,
  };
}

function bgLayer(container: HTMLElement): HTMLElement {
  const layer = container.querySelector<HTMLElement>(
    "[data-testid='drplay-player-bg']",
  );
  if (!layer) throw new Error("player background layer not rendered");
  return layer;
}

/** Deliver the engine load-start + the one-shot first-present event, which is
 *  what makes the background layer punch the host hole. */
async function presentFirstFrame(trackId: string): Promise<void> {
  storeState.currentTrack = { id: trackId, title: trackId };
  act(() => {
    audioMock._emit("buffering", { isBuffering: true, trackId, attempt: 1 });
  });
  await act(async () => {
    await Promise.resolve();
    for (const handler of eventMocks.handlers) handler();
  });
}

beforeEach(() => {
  tauriMocks.invoke.mockReset();
  tauriMocks.invoke.mockResolvedValue(undefined);
  eventMocks.listen.mockClear();
  eventMocks.handlers.length = 0;
  storeState.errorInfo = null;
  storeState.currentTrack = null;
});

afterEach(() => {
  cleanup();
});

describe("Now Playing while PiP owns the video", () => {
  it("renders the placeholder panel instead of a VideoSurface", () => {
    const { container, queryByTestId } = render(
      <NowPlayingView {...baseProps()} currentTrack={VIDEO} isPipActive />,
    );

    // The video area still exists (other surfaces anchor on it)...
    const area = container.querySelector<HTMLElement>(
      "[data-testid='video-area']",
    );
    expect(area).not.toBeNull();
    expect(area?.className).toContain("bg-black");
    expect(area?.textContent).toContain(PIP_TEXT_KEY);
    // ...but the native-host owner is NOT mounted a second time in main.
    expect(queryByTestId("video-surface")).toBeNull();
  });

  it("keeps the real VideoSurface when PiP is inactive", () => {
    const { container, queryByTestId } = render(
      <NowPlayingView {...baseProps()} currentTrack={VIDEO} />,
    );

    expect(queryByTestId("video-surface")).not.toBeNull();
    expect(
      container.querySelector<HTMLElement>("[data-testid='video-area']")
        ?.textContent,
    ).not.toContain(PIP_TEXT_KEY);
  });

  it("does not punch the host hole in the background layer while PiP owns it", async () => {
    const { container } = render(
      <NowPlayingView {...baseProps()} currentTrack={VIDEO} isPipActive />,
    );

    await presentFirstFrame(VIDEO.id);

    expect(bgLayer(container).style.clipPath).toBe("");
    expect(bgLayer(container).style.clipPath).not.toContain("evenodd");
  });

  it("still punches the hole when PiP is inactive (control case)", async () => {
    const { container } = render(
      <NowPlayingView {...baseProps()} currentTrack={VIDEO} />,
    );

    await presentFirstFrame(VIDEO.id);

    expect(bgLayer(container).style.clipPath).toContain("polygon(evenodd");
  });

  it("leaves audio tracks alone", () => {
    const { container } = render(
      <NowPlayingView {...baseProps()} currentTrack={AUDIO} isPipActive />,
    );

    expect(container.querySelector("[data-testid='video-area']")).toBeNull();
    expect(
      container.querySelector("[data-testid='drplay-player-bg']"),
    ).toBeNull();
  });

  it("suppresses the video context menu while PiP owns the picture", () => {
    const onOpenVideoMenuAt = vi.fn();
    const { container } = render(
      <NowPlayingView
        {...baseProps()}
        currentTrack={VIDEO}
        isPipActive
        onOpenVideoMenuAt={onOpenVideoMenuAt}
      />,
    );
    const area = container.querySelector<HTMLElement>(
      "[data-testid='video-area']",
    );
    if (!area) throw new Error("video area not rendered");

    // The browser menu stays blocked (the app never wants it)...
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    area.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    // ...but DrPlay's own video menu is NOT opened: it would act on a picture
    // that lives in another window.
    expect(onOpenVideoMenuAt).not.toHaveBeenCalled();
  });
});

describe("player.pip.playing_in_pip translations", () => {
  it("exists and is non-empty in both locales", () => {
    const pipEn = en.player.pip as Record<string, string>;
    const pipVi = viLocale.player.pip as Record<string, string>;
    expect((pipEn["playing_in_pip"] ?? "").trim()).not.toBe("");
    expect((pipVi["playing_in_pip"] ?? "").trim()).not.toBe("");
    // The Vietnamese copy must stay Vietnamese (no mojibake replacement char).
    expect(pipVi["playing_in_pip"]).not.toContain("\uFFFD");
  });
});
