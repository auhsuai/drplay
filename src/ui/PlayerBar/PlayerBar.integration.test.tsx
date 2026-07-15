// @vitest-environment jsdom
//
// FAITHFUL INTEGRATION TEST — does clicking the on-screen Next/Prev button
// actually ADVANCE the track, end-to-end (real usePlayer + real PlayerBar)?
//
// This isolates the user-reported symptom: "keyboard 'n' advances, but the
// on-screen Next BUTTON does not." Source analysis says both call the same
// handleNextClick -> handleNextTrack, so if this test PASSES the button works
// in source and the user is on a stale build. If it FAILS, we've reproduced
// a real bug and can trace exactly where it dies.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { PlayerBar } from "./PlayerBar";
import { usePlayer } from "../../hooks/usePlayer";
import type { PlayerBarProps } from "./types";
import type { Track } from "../../App";

// ---- Mocks for every non-React / Tauri / browser dependency ------------
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string, d?: string) => (d ?? k) as string }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "get_stream_url") return "fake://stream/url";
    if (cmd === "update_buffer_settings") return undefined;
    return undefined;
  }),
}));
vi.mock("idb-keyval", () => ({
  get: vi.fn(async () => undefined),
  set: vi.fn(async () => undefined),
  del: vi.fn(async () => undefined),
  keys: vi.fn(async () => []),
}));
vi.mock("tauri-plugin-keepawake-api", () => ({
  start: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
}));
vi.mock("../../utils/crossfade", () => ({
  CrossfadeEngine: class {
    ensureContext() { return Promise.resolve(this); }
    destroy() {}
  },
}));
vi.mock("../../utils/metadata", () => ({
  getTrackMetadata: vi.fn(async () => ({ duration: 180 })),
  updateTrackDuration: vi.fn(),
}));
vi.mock("../../utils/apiClient", () => ({
  getValidToken: vi.fn(async () => "fake-token"),
}));
vi.mock("../../utils/streamPrefetcher", () => ({
  getPrefetchedStreamUrl: vi.fn(() => undefined),
}));
vi.mock("../../utils/history", () => ({
  recordPlay: vi.fn(),
}));
vi.mock("../../utils/favorites", () => ({
  isFavorite: vi.fn(() => Promise.resolve(false)),
  addFavorite: vi.fn(() => Promise.resolve()),
  removeFavorite: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../utils/safeAudio", () => ({
  safePlay: vi.fn(() => Promise.resolve()),
  safePause: vi.fn(),
}));
vi.mock("../components/MoreMenu", () => ({
  MoreMenu: () => null,
}));

// crypto.randomUUID used by usePlayer to assign queueItemId
if (!globalThis.crypto) {
  // @ts-expect-error test shim
  globalThis.crypto = {};
}
if (!globalThis.crypto.randomUUID) {
  let n = 0;
  (globalThis.crypto as any).randomUUID = () => `uuid-${++n}`;
}

function makeTrack(id: string): Track {
  return { id, title: `Title ${id}`, artist: `Artist ${id}`, streamUrl: "" };
}

// Harness: real usePlayer backing the real PlayerBar.
function Harness({ onReady }: { onReady: (p: ReturnType<typeof usePlayer>) => void }) {
  const player = usePlayer("fake-token");
  onReady(player);
  const props: PlayerBarProps = {
    currentTrack: player.currentTrack,
    isPlaying: player.isPlaying,
    onTogglePlay: player.handleTogglePlay,
    onNextTrack: player.handleNextTrack,
    onPrevTrack: player.handlePrevTrack,
    isDownloading: player.isDownloading,
    loadNonce: 0,
    playMode: player.playMode,
    onTogglePlayMode: player.handleTogglePlayMode,
    onExpandNowPlaying: () => {},
    crossfadeEnabled: false,
    crossfadeDuration: 0,
  };
  return <PlayerBar {...props} />;
}

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

let playerRef: ReturnType<typeof usePlayer> | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
  playerRef = null;
});

describe("PlayerBar + usePlayer integration — button advances track", () => {
  it("clicking on-screen Next BUTTON advances to the next track", async () => {
    const A = makeTrack("A");
    const B = makeTrack("B");
    const C = makeTrack("C");
    const D = makeTrack("D");

    const { container } = render(<Harness onReady={(p) => { playerRef = p; }} />);
    await flush();
    expect(playerRef).toBeTruthy();

    // Play A with a real context queue [A,B,C,D]
    await act(async () => {
      await playerRef!.handlePlayTrack(A, [A, B, C, D], false);
    });
    await flush();

    expect(playerRef!.currentTrack?.id).toBe("A");

    const nextBtn = container
      .querySelector(".lucide-skip-forward")
      ?.closest("button") as HTMLButtonElement | null;
    expect(nextBtn).toBeTruthy();

    await act(async () => {
      fireEvent.click(nextBtn!);
    });
    await flush();

    expect(playerRef!.currentTrack?.id).toBe("B");
  });

  it("pressing keyboard 'n' also advances (sanity check)", async () => {
    const A = makeTrack("A");
    const B = makeTrack("B");
    const C = makeTrack("C");
    const D = makeTrack("D");

    const { } = render(<Harness onReady={(p) => { playerRef = p; }} />);
    await flush();

    await act(async () => {
      await playerRef!.handlePlayTrack(A, [A, B, C, D], false);
    });
    await flush();
    expect(playerRef!.currentTrack?.id).toBe("A");

    await act(async () => {
      fireEvent.keyDown(window, { key: "n" });
    });
    await flush();

    expect(playerRef!.currentTrack?.id).toBe("B");
  });
});
