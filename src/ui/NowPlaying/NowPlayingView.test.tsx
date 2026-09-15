// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Track } from "../../types";
import en from "../../locales/en/translation.json";
import { NowPlayingView } from "./NowPlayingView";

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

vi.mock("../../lib/AudioController", () => ({
  AudioController: { getInstance: () => ({ on: () => () => {} }) },
}));

vi.mock("../../store/playerStore", () => ({
  usePlayerStore: (selector: (s: { isDownloading: boolean }) => unknown) =>
    selector({ isDownloading: false }),
}));

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

vi.mock("../components/SeekBar", () => ({ SeekBar: () => null }));

function makeTrack(): Track {
  return {
    id: "track-1",
    title: "Song",
    artist: "Artist",
    streamUrl: "/drive-stream/track-1",
  };
}

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
  };
}

afterEach(() => {
  cleanup();
});

describe("NowPlayingView back-button accessible name (P2-12-3)", () => {
  it("empty state → nút back có accessible name common.close", () => {
    render(<NowPlayingView {...baseProps()} />);

    expect(screen.getByRole("button", { name: en.common.close })).toBeTruthy();
  });

  it("track state → nút back có accessible name common.close", () => {
    render(<NowPlayingView {...baseProps()} currentTrack={makeTrack()} />);

    expect(screen.getByRole("button", { name: en.common.close })).toBeTruthy();
  });
});
