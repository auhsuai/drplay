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

  it("the Audio/Subtitle/More buttons open the matching menu section", () => {
    const props = baseProps();
    render(<VideoPlayerBar {...props} />);

    fireEvent.click(
      screen.getByRole("button", { name: en.player.menu.audio_track }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: en.player.menu.subtitle_track }),
    );
    fireEvent.click(screen.getByRole("button", { name: en.player.more }));

    expect(props.onOpenMenu).toHaveBeenNthCalledWith(1, "audio");
    expect(props.onOpenMenu).toHaveBeenNthCalledWith(2, "subtitle");
    expect(props.onOpenMenu).toHaveBeenNthCalledWith(3, "full");
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
      fireEvent.click(
        screen.getByRole("button", { name: en.player.menu.audio_track }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: en.player.menu.subtitle_track }),
      );
      fireEvent.click(screen.getByRole("button", { name: en.player.more }));
    }).not.toThrow();
  });
});

describe("VideoPlayerBar responsive rules", () => {
  it("keeps Audio/Subtitle available but hidden below lg; More is always visible", () => {
    render(<VideoPlayerBar {...baseProps()} />);

    const audioButton = screen.getByRole("button", {
      name: en.player.menu.audio_track,
    });
    const subtitleButton = screen.getByRole("button", {
      name: en.player.menu.subtitle_track,
    });
    const moreButton = screen.getByRole("button", { name: en.player.more });

    expect(audioButton.className).toContain("hidden");
    expect(audioButton.className).toContain("lg:inline-flex");
    expect(subtitleButton.className).toContain("hidden");
    expect(subtitleButton.className).toContain("lg:inline-flex");
    expect(moreButton.className).not.toContain("hidden");
  });
});
