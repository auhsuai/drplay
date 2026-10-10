// @vitest-environment jsdom
/**
 * D3 media-player bar: ONE horizontal row — transport left, title + seekbar
 * center, volume + A/V/More right. The bar reuses the existing PlayerBar
 * components verbatim; this suite pins the wiring and the responsive rules.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AudioController } from "../../../lib/AudioController";
import type { Track } from "../../../types";
import type { VideoMenuAnchor } from "../../../player/useVideoMenu";
import en from "../../../locales/en/translation.json";

vi.mock("react-i18next", () => {
  const resolveKey = (key: string): string | undefined => {
    let acc: unknown = en;
    for (const part of key.split(".")) {
      if (typeof acc === "object" && acc !== null) {
        acc = (acc as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }
    return typeof acc === "string" ? acc : undefined;
  };
  return {
    useTranslation: () => ({
      t: (key: string, fallback?: string) => resolveKey(key) ?? fallback ?? key,
    }),
  };
});

const audioMock = vi.hoisted(() => ({
  getVolume: vi.fn(() => 0.5),
  isMuted: vi.fn(() => false),
  toggleMute: vi.fn(() => false),
  setVolume: vi.fn(),
}));
vi.mock("../../../lib/AudioController", () => ({
  AudioController: { getInstance: () => audioMock },
}));

vi.mock("../../components/SeekBar", () => ({
  SeekBar: () => <div data-testid="seekbar-stub" />,
}));

import { VideoPlayerBar } from "./VideoPlayerBar";

const TRACK: Track = {
  id: "v1",
  title: "A very long movie title that has to be truncated by the bar",
  artist: "",
  streamUrl: "/drive-stream/v1",
  originalName: "Movie.mkv",
};

function baseProps() {
  return {
    currentTrack: TRACK,
    isPlaying: false,
    isBuffering: false,
    isDownloading: false,
    hasError: false,
    onRetry: vi.fn(),
    playMode: "normal" as const,
    onTogglePlay: vi.fn(),
    onNext: vi.fn(),
    onPrev: vi.fn(),
    onTogglePlayMode: vi.fn(),
    audio: audioMock as unknown as AudioController,
    isFullscreen: false,
    onToggleFullscreen: vi.fn(),
    onOpenMenu: vi.fn(),
  };
}

afterEach(() => {
  cleanup();
});

describe("VideoPlayerBar structure", () => {
  it("renders one horizontal, non-wrapping row with transport, seekbar and volume", () => {
    const { container } = render(<VideoPlayerBar {...baseProps()} />);

    const bar = container.querySelector("[data-testid='video-player-bar']");
    expect(bar).not.toBeNull();
    expect(bar?.className).toContain("flex-nowrap");
    expect(
      container.querySelector(
        "[data-testid='video-player-bar'] [data-testid='seekbar-stub']",
      ),
    ).not.toBeNull();
    expect(
      container.querySelector("[data-testid='volume-bar']"),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: en.player.prev })).toBeTruthy();
    expect(screen.getByRole("button", { name: en.player.play })).toBeTruthy();
    expect(screen.getByRole("button", { name: en.player.next })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: en.player.play_mode }),
    ).toBeTruthy();
  });

  it("shows the track title truncated, with the full title on the title attribute", () => {
    const { container } = render(<VideoPlayerBar {...baseProps()} />);

    const title = container.querySelector<HTMLElement>(
      "[data-testid='video-player-bar-title']",
    );
    expect(title).not.toBeNull();
    expect(title?.textContent).toBe(TRACK.title);
    expect(title?.getAttribute("title")).toBe(TRACK.title);
    expect(title?.className).toContain("truncate");
    expect(title?.className).toContain("hidden");
    expect(title?.className).toContain("md:block");
    expect(title?.className).toContain("max-w-[28ch]");
  });

  it("uses the default responsive VolumeSlider rail (visible from xl and up)", () => {
    const { container } = render(<VideoPlayerBar {...baseProps()} />);

    const rail = container.querySelector<HTMLElement>(
      "[data-testid='volume-bar']",
    );
    expect(rail?.className).toContain("hidden");
    expect(rail?.className).toContain("xl:flex");
  });
});

describe("VideoPlayerBar wiring", () => {
  it("transport buttons fire the callbacks they were given", () => {
    const props = baseProps();
    render(<VideoPlayerBar {...props} />);

    fireEvent.click(screen.getByRole("button", { name: en.player.play }));
    fireEvent.click(screen.getByRole("button", { name: en.player.next }));
    fireEvent.click(screen.getByRole("button", { name: en.player.prev }));
    fireEvent.click(screen.getByRole("button", { name: en.player.play_mode }));

    expect(props.onTogglePlay).toHaveBeenCalledTimes(1);
    expect(props.onNext).toHaveBeenCalledTimes(1);
    expect(props.onPrev).toHaveBeenCalledTimes(1);
    expect(props.onTogglePlayMode).toHaveBeenCalledTimes(1);
  });

  // Slice 2: the More button no longer opens a NATIVE menu section — it opens
  // the DrPlay video menu and hands over the anchor it was measured at. Old
  // assertion: `expect(props.onOpenMenu).toHaveBeenNthCalledWith(1, "full")`.
  // It is superseded because the second argument (the measured trigger anchor)
  // IS the behaviour under test; the section is still the first argument.
  it("the More button opens the full menu section at its own measured anchor", () => {
    const props = baseProps();
    const onOpenMenu = vi.fn<(section: string, anchor: unknown) => void>();
    render(<VideoPlayerBar {...props} onOpenMenu={onOpenMenu} />);

    fireEvent.click(screen.getByRole("button", { name: en.player.more }));

    expect(onOpenMenu).toHaveBeenCalledTimes(1);
    const [section, rawAnchor] = onOpenMenu.mock.calls[0] ?? [];
    expect(section).toBe("full");
    const anchor = rawAnchor as Extract<VideoMenuAnchor, { kind: "button" }>;
    expect(anchor.kind).toBe("button");
    // The anchor really is this button (with its measured rect), so the owner
    // needs no DOM knowledge of the bar.
    expect(anchor.trigger).toBe(
      screen.getByRole("button", { name: en.player.more }),
    );
    expect(anchor.rect).toBeTruthy();
    expect(props.onOpenMenu).not.toHaveBeenCalled();
  });

  // Slice 1 (D): the standalone audio-track / subtitle-track buttons were
  // removed from the bar — both are reachable through the native menu (the
  // More button's "full" section, and the right-click submenus), so the bar
  // duplicated two menu entry points for no extra capability.
  it("no longer renders the standalone audio-track / subtitle-track buttons", () => {
    render(<VideoPlayerBar {...baseProps()} />);

    expect(
      screen.queryByRole("button", { name: en.player.menu.audio_track }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: en.player.menu.subtitle_track }),
    ).toBeNull();
  });

  it("still renders volume, fullscreen and More after the removal", () => {
    const { container } = render(<VideoPlayerBar {...baseProps()} />);

    expect(
      container.querySelector("[data-testid='volume-bar']"),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: en.player.fullscreen }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: en.player.more })).toBeTruthy();
    // Transport is untouched by both the removal and the fullscreen work.
    expect(screen.getByRole("button", { name: en.player.play })).toBeTruthy();
  });

  it("the fullscreen button mirrors the state, toggles, and swaps its icon", () => {
    const props = baseProps();
    const { rerender } = render(<VideoPlayerBar {...props} />);

    const enter = screen.getByRole("button", { name: en.player.fullscreen });
    expect(enter.querySelector(".lucide-maximize")).not.toBeNull();
    fireEvent.click(enter);
    expect(props.onToggleFullscreen).toHaveBeenCalledTimes(1);

    rerender(<VideoPlayerBar {...props} isFullscreen />);
    const exit = screen.getByRole("button", {
      name: en.player.exit_fullscreen,
    });
    expect(exit.querySelector(".lucide-minimize")).not.toBeNull();
  });

  it("without onOpenMenu the menu buttons are a safe no-op", () => {
    const props = baseProps();
    render(<VideoPlayerBar {...props} onOpenMenu={undefined} />);

    expect(() => {
      fireEvent.click(screen.getByRole("button", { name: en.player.more }));
    }).not.toThrow();
  });
});

describe("VideoPlayerBar responsive rules", () => {
  it("More is always visible (no breakpoint gating left on the bar)", () => {
    render(<VideoPlayerBar {...baseProps()} />);

    const moreButton = screen.getByRole("button", { name: en.player.more });

    expect(moreButton.className).not.toContain("hidden");
  });
});

// ---------------------------------------------------------------------------
// Slice 1 (B): in fullscreen the bar FLOATS over the video. It must be out of
// flow so showing/hiding it can never resize or reposition the surface, and
// hidden must be a CSS mechanism (opacity + pointer-events-none) with no
// layout reservation.
// ---------------------------------------------------------------------------
describe("VideoPlayerBar fullscreen floating", () => {
  function bar(container: HTMLElement): HTMLElement {
    const el = container.querySelector<HTMLElement>(
      "[data-testid='video-player-bar']",
    );
    if (!el) throw new Error("video player bar not rendered");
    return el;
  }

  it("is in the normal flow outside fullscreen (windowed layout unchanged)", () => {
    const { container } = render(<VideoPlayerBar {...baseProps()} />);
    const el = bar(container);

    expect(el.className).toContain("shrink-0");
    expect(el.className).not.toContain("absolute");
    expect(el.className).not.toContain("pointer-events-none");
  });

  it("is absolutely positioned over the video in fullscreen", () => {
    const { container } = render(
      <VideoPlayerBar {...baseProps()} isFullscreen chromeVisible />,
    );
    const el = bar(container);

    expect(el.className).toContain("absolute");
    expect(el.className).toContain("inset-x-0");
    expect(el.className).toContain("bottom-0");
    // Out of flow: nothing the bar can do changes the video's box.
    expect(el.className).not.toContain("shrink-0");
    // The fullscreen scrim REPLACES the windowed surface paint: both on the
    // same element would leave the winner to stylesheet source order.
    expect(el.className).not.toContain("bg-white");
    expect(el.className).not.toContain("dark:bg-[#202124]");
  });

  it("hidden fullscreen = opacity + pointer-events-none, never display:none", () => {
    const { container, rerender } = render(
      <VideoPlayerBar {...baseProps()} isFullscreen chromeVisible />,
    );
    expect(bar(container).className).toContain("opacity-100");
    expect(bar(container).className).not.toContain("pointer-events-none");

    rerender(
      <VideoPlayerBar {...baseProps()} isFullscreen chromeVisible={false} />,
    );
    const hidden = bar(container);
    expect(hidden.className).toContain("opacity-0");
    expect(hidden.className).toContain("pointer-events-none");
    // Exactly ONE opacity utility may be present: two conflicting ones would
    // be resolved by stylesheet source order, not by this class string.
    expect(
      hidden.className.split(/\s+/).filter((c) => c.startsWith("opacity-")),
    ).toEqual(["opacity-0"]);
    // Still rendered and still out of flow -> no reflow when it comes back.
    expect(hidden.className).not.toContain("hidden");
    expect(hidden.className).not.toContain("display");
    // Short, unobtrusive transition (the app's own duration-200 language).
    expect(hidden.className).toContain("duration-200");
  });

  it("defaults to visible so a caller without the hook is unaffected", () => {
    const { container } = render(<VideoPlayerBar {...baseProps()} />);
    expect(bar(container).className).toContain("opacity-100");
  });
});
