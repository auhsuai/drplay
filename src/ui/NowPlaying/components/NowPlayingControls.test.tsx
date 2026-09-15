// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import en from "../../../locales/en/translation.json";
import { NowPlayingControls } from "./NowPlayingControls";

vi.mock("react-i18next", () => {
  // Resolve keys against the real en resources so assertions read the
  // shipped copy instead of hard-coded fallbacks.
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

function baseProps(
  over: Partial<Parameters<typeof NowPlayingControls>[0]> = {},
) {
  return {
    isPlaying: false,
    isBuffering: false,
    isDownloading: false,
    onTogglePlay: vi.fn(),
    onNextTrack: vi.fn(),
    onPrevTrack: vi.fn(),
    playMode: "normal" as const,
    onTogglePlayMode: vi.fn(),
    ...over,
  };
}

// The play button is the only brand-primary button in the control row.
function getPlayButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    "button.bg-brand-primary",
  );
  if (!button) throw new Error("play button not found");
  return button;
}

describe("NowPlayingControls play-button state matrix", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows spinner and disables the button while downloading (intent window)", () => {
    // Regression: handlePlayTrack sets isDownloading before the async token
    // fetch — during that window isPlaying is still false, so the button must
    // not fall back to the ▲ Play icon (parity with TransportControls).
    const { container } = render(
      <NowPlayingControls {...baseProps({ isDownloading: true })} />,
    );
    expect(container.querySelector(".animate-spin")).not.toBeNull();
    expect(getPlayButton(container).disabled).toBe(true);
    expect(container.querySelector(".lucide-play")).toBeNull();
    expect(container.querySelector(".lucide-pause")).toBeNull();
  });

  it("keeps the spinner while downloading even if isPlaying is already true", () => {
    const { container } = render(
      <NowPlayingControls
        {...baseProps({ isDownloading: true, isPlaying: true })}
      />,
    );
    expect(container.querySelector(".animate-spin")).not.toBeNull();
    expect(getPlayButton(container).disabled).toBe(true);
    expect(container.querySelector(".lucide-pause")).toBeNull();
  });

  it("shows spinner for buffering while playing (pre-existing behavior)", () => {
    const { container } = render(
      <NowPlayingControls
        {...baseProps({ isBuffering: true, isPlaying: true })}
      />,
    );
    expect(container.querySelector(".animate-spin")).not.toBeNull();
    expect(getPlayButton(container).disabled).toBe(false);
  });

  it("shows pause when playing without buffering or downloading", () => {
    const { container } = render(
      <NowPlayingControls {...baseProps({ isPlaying: true })} />,
    );
    expect(container.querySelector(".lucide-pause")).not.toBeNull();
    expect(container.querySelector(".animate-spin")).toBeNull();
    expect(getPlayButton(container).disabled).toBe(false);
  });

  it("shows play when idle (e.g. aborted intent with no token)", () => {
    const { container } = render(<NowPlayingControls {...baseProps()} />);
    expect(container.querySelector(".lucide-play")).not.toBeNull();
    expect(container.querySelector(".animate-spin")).toBeNull();
    expect(getPlayButton(container).disabled).toBe(false);
  });
});

describe("NowPlayingControls accessible names (P2-12-1)", () => {
  afterEach(() => {
    cleanup();
  });

  it("labels all four icon-only transport buttons when idle", () => {
    render(<NowPlayingControls {...baseProps()} />);

    expect(screen.getByRole("button", { name: en.player.prev })).toBeTruthy();
    expect(screen.getByRole("button", { name: en.player.next })).toBeTruthy();
    expect(screen.getByRole("button", { name: en.player.play })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: en.player.play_mode }),
    ).toBeTruthy();
  });

  it("swaps the play button name to Pause while playing", () => {
    render(<NowPlayingControls {...baseProps({ isPlaying: true })} />);

    expect(screen.queryByRole("button", { name: en.player.play })).toBeNull();
    expect(screen.getByRole("button", { name: en.player.pause })).toBeTruthy();
  });
});
