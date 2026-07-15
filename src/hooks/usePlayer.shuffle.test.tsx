// @vitest-environment jsdom
//
// ============================================================================
// REGRESSION / REPRODUCTION: "Next/Prev doesn't change track in shuffle mode"
// ============================================================================
//
// This test drives the REAL `usePlayer` hook (React 19 runtime, jsdom) via
// @testing-library/react renderHook + act. Every non-React import the hook
// touches is mocked so it loads outside Tauri.
//
// FINDINGS ENCODED HERE (see investigation dossier):
//
//  1. usePlayer's shuffle Next/Prev QUEUE LOGIC IS CORRECT. When the handler
//     is called from the LATEST committed render (the ⏭/⏮ *button* path:
//     PlayerBar button onClick -> usePlaybackControl.handleNextClick ->
//     onNextTrack(fresh prop)), the track advances in shuffle mode.
//     -> Tests 1 & 2 PASS.
//
//  2. THE ACTUAL BUG was a STALE-CLOSURE at the caller. PlayerBar.tsx captured
//     the Next/Prev callbacks in refs created ONCE and never re-synced:
//         src/ui/PlayerBar/PlayerBar.tsx:32  const onNextTrackRef = useRef(onNextTrack);
//         src/ui/PlayerBar/PlayerBar.tsx:33  const onPrevTrackRef = useRef(onPrevTrack);
//     (contrast: usePlaybackControl.ts re-syncs its own refs every render)
//     Those frozen refs were consumed by:
//         - keyboard Next/Prev        src/ui/PlayerBar/useKeyboard.ts:121,126
//         - auto-advance on song end  src/ui/PlayerBar/useAudioEngine.ts:239
//     FIXED: PlayerBar now re-syncs onNextTrackRef/onPrevTrackRef to
//     playbackControl.handleNextClick/handlePrevClick on every render (see
//     PlayerBar.nextPrev.test.tsx for the real regression guard that mounts the
//     component and proves the ref tracks the latest handler).

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
const D = makeTrack("D");

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

describe("usePlayer — shuffle Next/Prev", () => {
  // ---- 1. Baseline: normal mode, fresh handler (button path) --------------
  it("normal mode: fresh handleNextTrack advances the track (baseline)", async () => {
    const { result } = renderHook(() => usePlayer("fake-token"));

    await act(async () => {
      await result.current.handlePlayTrack(A, [A, B, C, D], false);
    });
    await flush();

    expect(result.current.currentTrack?.id).toBe("A");
    expect(result.current.playMode).toBe("normal");

    const before = result.current.currentTrack?.id;
    await act(async () => {
      result.current.handleNextTrack();
    });
    await flush();

    expect(result.current.currentTrack?.id).not.toBe(before);
  });

  // ---- 2. usePlayer shuffle logic is CORRECT via the fresh/button path -----
  it("shuffle mode: fresh handleNextTrack advances the track (the ⏭ button path)", async () => {
    const { result } = renderHook(() => usePlayer("fake-token"));

    await act(async () => {
      await result.current.handlePlayTrack(A, [A, B, C, D], false);
    });
    await flush();
    expect(result.current.currentTrack?.id).toBe("A");

    await act(async () => {
      result.current.handleTogglePlayMode(); // normal -> shuffle
    });
    await flush();
    expect(result.current.playMode).toBe("shuffle");

    const before = result.current.currentTrack?.id;
    await act(async () => {
      result.current.handleNextTrack(); // called from the LATEST render
    });
    await flush();

    // Proves the hook's queue math + nested-setState-in-updater commit correctly.
    expect(result.current.currentTrack?.id).not.toBe(before);
  });

});

