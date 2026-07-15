// @vitest-environment jsdom
//
// ============================================================================
// REGRESSION: "Next/Prev silently dead after playing a track WITHOUT a contextQueue"
// ============================================================================
//
// Root cause (confirmed by Main Agent): handlePlayTrack's `else` branch
// (src/hooks/usePlayer.ts, lines 213-217) sets a queueItemId on the track but
// NEVER calls setPlaybackQueue(...). So playbackQueue stays []/stale for
// contextQueue-less plays. Subsequent handleNextTrack/handlePrevTrack then hit
// the `currentIndex === -1` silent return (lines 303 / 318) -> Next/Prev do nothing.
//
// This test plays a track with NO contextQueue and asserts the playback queue
// is populated with the current track (fix A). It also guards that
// handleNextTrack does not silently crash when the current track IS in the queue.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

// ---- Mocks for every non-React import usePlayer uses -----------------------

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "get_stream_url") return "fake://stream/url";
    return undefined;
  }),
}));

vi.mock("idb-keyval", () => ({
  get: vi.fn(async () => undefined),
  set: vi.fn(async () => undefined),
  del: vi.fn(async () => undefined),
}));

vi.mock("tauri-plugin-keepawake-api", () => ({
  start: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
}));

vi.mock("../utils/metadata", () => ({
  getTrackMetadata: vi.fn(async () => ({ duration: 180 })),
}));

vi.mock("../utils/apiClient", () => ({
  getValidToken: vi.fn(async () => "fake-token"),
}));

vi.mock("../utils/streamPrefetcher", () => ({
  getPrefetchedStreamUrl: vi.fn(() => undefined),
}));

import { usePlayer } from "./usePlayer";
import type { Track } from "../App";

// ---- Fixtures --------------------------------------------------------------

function makeTrack(id: string): Track {
  return { id, title: `Title ${id}`, artist: `Artist ${id}`, streamUrl: "" };
}

const A = makeTrack("A");
const B = makeTrack("B");
const C = makeTrack("C");
const Z = makeTrack("Z");

// Flush pending microtasks + any 0ms timers the async handlers queue.
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("usePlayer — contextQueue-less play establishes a playback queue", () => {
  // ---- 1. Playing a single track without a contextQueue populates the queue --
  it("playing a track without a contextQueue still establishes a playback queue containing the current track", async () => {
    const { result } = renderHook(() => usePlayer("fake-token"));

    await act(async () => {
      await result.current.handlePlayTrack(Z);
    });
    await flush();

    expect(result.current.currentTrack?.id).toBe("Z");
    // ROOT-CAUSE GUARD: before the fix playbackQueue is [] here.
    expect(result.current.playbackQueue.some(t => t.id === "Z")).toBe(true);
  });

  // ---- 2. Playing a contextQueue track then a contextQueue-less one resets ---
  it("playing a contextQueue track (A,[A,B,C]) then a contextQueue-less track (Z) leaves a queue containing Z", async () => {
    const { result } = renderHook(() => usePlayer("fake-token"));

    await act(async () => {
      await result.current.handlePlayTrack(A, [A, B, C], false);
    });
    await flush();
    expect(result.current.currentTrack?.id).toBe("A");
    expect(result.current.playbackQueue.length).toBe(3);

    await act(async () => {
      await result.current.handlePlayTrack(Z);
    });
    await flush();

    expect(result.current.currentTrack?.id).toBe("Z");
    expect(result.current.playbackQueue.some(t => t.id === "Z")).toBe(true);
    expect(result.current.playbackQueue.some(t => t.id === "A")).toBe(false);
  });

  // ---- 3. handleNextTrack does not silently dead-track when current is in queue
  it("handleNextTrack advances (or no-ops gracefully) without crashing when current track is in queue", async () => {
    const { result } = renderHook(() => usePlayer("fake-token"));

    await act(async () => {
      await result.current.handlePlayTrack(Z);
    });
    await flush();
    expect(result.current.playbackQueue.some(t => t.id === "Z")).toBe(true);

    // Single-track queue: Next should not advance (no next item) but must not
    // throw or crash the hook.
    await act(async () => {
      result.current.handleNextTrack();
    });
    await flush();
    expect(result.current.currentTrack?.id).toBe("Z");
    expect(() => result.current.handleNextTrack()).not.toThrow();
  });
});
