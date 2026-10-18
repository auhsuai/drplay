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

// Records the props so a test can assert WHICH seekbar variant the bar asks
// for — the stub itself renders nothing (the real rail's markup is SeekBar's
// own test suite).
const seekbarProps: { variant?: string | undefined } = {};
vi.mock("../../components/SeekBar", () => ({
  SeekBar: (props: { variant?: string }) => {
    seekbarProps.variant = props.variant;
    return <div data-testid="seekbar-stub" />;
  },
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

describe("VideoPlayerBar seekbar matches the collapsed PlayerBar", () => {
  it("asks for the same `top` variant the PlayerBar uses", () => {
    render(<VideoPlayerBar {...baseProps()} />);

    // `top` pins the rail to the bar's top edge, edge-to-edge and square —
    // the exact line the collapsed PlayerBar shows. The in-flow default put it
    // between two clocks in the middle of the row instead.
    expect(seekbarProps.variant).toBe("top");
  });

  it("renders the seekbar as a direct child of the bar, with no empty wrapper", () => {
    const { container } = render(<VideoPlayerBar {...baseProps()} />);

    const stub = container.querySelector("[data-testid='seekbar-stub']");
    expect(stub?.parentElement).toBe(
      container.querySelector("[data-testid='video-player-bar']"),
    );
  });

  it("is positioned in both modes — the windowed bar needs a positioned root", () => {
    // In fullscreen the bar root is already `absolute`; windowed it has to opt
    // in, or the rail's `absolute inset-x-0 top-0` would resolve against some
    // distant ancestor and fly to the top of the app.
    const windowed = render(<VideoPlayerBar {...baseProps()} />);
    const windowedBar = windowed.container.querySelector(
      "[data-testid='video-player-bar']",
    ) as HTMLElement;
    expect(windowedBar.className).toContain("relative");
    windowed.unmount();

    render(<VideoPlayerBar {...baseProps()} isFullscreen />);
    const fullBar = document.querySelector(
      "[data-testid='video-player-bar']",
    ) as HTMLElement;
    expect(fullBar.className).toContain("absolute");
    expect(fullBar.className).not.toContain("relative");
  });
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
    // Fullscreen deliberately SHARES the windowed palette — do not "fix" this
    // back into a separate scrim. The collision this guards against is the old
    // scrim utilities returning alongside these, not the palette being shared.
    expect(el.className).toContain("bg-white");
    expect(el.className).toContain("dark:bg-[#202124]");
    expect(el.className).toContain("border-gray-200");
    expect(el.className).toContain("dark:border-[#2A2A2A]");
    // Exactly ONE background and ONE border colour utility: two competing ones
    // on the same element leave the winner to stylesheet source order (the trap
    // that shipped the broken VideoMenu flyout).
    expect(el.className).not.toContain("bg-[#121212]");
    expect(el.className).not.toContain("border-white/10");
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
