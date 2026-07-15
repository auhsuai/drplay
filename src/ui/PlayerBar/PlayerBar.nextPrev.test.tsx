// @vitest-environment jsdom
//
// ============================================================================
// REGRESSION TEST — PlayerBar freezes onNextTrack/onPrevTrack in stale refs
// ============================================================================
//
// Root cause (confirmed by reading + runtime repro):
//   src/ui/PlayerBar/PlayerBar.tsx created `onNextTrackRef = useRef(onNextTrack)`
//   and `onPrevTrackRef = useRef(onPrevTrack)` ONCE and never re-synced them.
//   Those frozen refs were consumed by useKeyboard (keys 'n'/'p') and
//   useAudioEngine (auto-advance on <audio onEnded>, error-skip). Because they
//   were frozen at first render, every call no-op'd.
//
// The fix re-syncs the stable PlayerBar-level refs to
//   playbackControl.handleNextClick / handlePrevClick
// (which carry the transition guards + auto-skip circuit breaker) on every
// render.
//
// This test mounts the REAL PlayerBar, swaps the onNextTrack prop from fnA to
// fnB, then drives Next via (a) keyboard 'n' and (b) the <audio> 'ended'
// event. It asserts fnB runs and fnA does NOT — proving the ref now tracks the
// latest handler. On pre-fix code the stale ref keeps fnA, so the assertions
// FAIL (reproduces the bug); after the fix they PASS.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { PlayerBar } from "./PlayerBar";
import type { PlayerBarProps } from "./types";
import type { Track } from "../../App";

// ---- Mocks for every non-React / Tauri / browser dependency -------------

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string, d?: string) => (d ?? k) as string }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));

vi.mock("idb-keyval", () => ({
  get: vi.fn(async () => undefined),
  set: vi.fn(async () => undefined),
  del: vi.fn(async () => undefined),
  keys: vi.fn(async () => []),
}));

vi.mock("../../utils/crossfade", () => ({
  CrossfadeEngine: class {
    ensureContext() {
      return Promise.resolve(this);
    }
    destroy() {}
  },
}));

vi.mock("../../utils/metadata", () => ({
  getTrackMetadata: vi.fn(async () => ({})),
  updateTrackDuration: vi.fn(),
}));

vi.mock("../../utils/apiClient", () => ({
  getValidToken: vi.fn(async () => "fake-token"),
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

// MoreMenu pulls in playlists/driveApi/db/FolderSelectionScreen — none of that
// matters for the ref-sync regression, so stub it to isolate the test.
vi.mock("../components/MoreMenu", () => ({
  MoreMenu: () => null,
}));

// ---- Fixtures -------------------------------------------------------------

const track: Track = { id: "A", title: "Track A", artist: "Artist", streamUrl: "http://x" };

function baseProps(over: Partial<PlayerBarProps>): PlayerBarProps {
  return {
    currentTrack: track,
    isPlaying: true,
    onTogglePlay: vi.fn(),
    onNextTrack: vi.fn(),
    onPrevTrack: vi.fn(),
    playMode: "normal",
    onTogglePlayMode: vi.fn(),
    onExpandNowPlaying: vi.fn(),
    crossfadeEnabled: false,
    crossfadeDuration: 0,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("PlayerBar — Next/Prev ref re-sync", () => {
  it("keyboard 'n' uses the LATEST onNextTrack (fnB), not the stale first-render fnA", async () => {
    const fnA = vi.fn();
    const fnB = vi.fn();

    const { rerender } = render(<PlayerBar {...baseProps({ onNextTrack: fnA })} />);
    // Swap the handler prop — on pre-fix code the ref stays frozen on fnA.
    rerender(<PlayerBar {...baseProps({ onNextTrack: fnB })} />);

    // Let effects (incl. the ref-sync effect) flush.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    fireEvent.keyDown(window, { key: "n" });

    expect(fnB).toHaveBeenCalledTimes(1);
    expect(fnA).not.toHaveBeenCalled();
  });

  it("keyboard 'p' uses the LATEST onPrevTrack (fnB), not the stale fnA", async () => {
    const fnA = vi.fn();
    const fnB = vi.fn();

    const { rerender } = render(<PlayerBar {...baseProps({ onPrevTrack: fnA })} />);
    rerender(<PlayerBar {...baseProps({ onPrevTrack: fnB })} />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    fireEvent.keyDown(window, { key: "p" });

    expect(fnB).toHaveBeenCalledTimes(1);
    expect(fnA).not.toHaveBeenCalled();
  });

  it("<audio onEnded> auto-advance uses the LATEST onNextTrack (fnB)", async () => {
    const fnA = vi.fn();
    const fnB = vi.fn();

    const { rerender, container } = render(<PlayerBar {...baseProps({ onNextTrack: fnA })} />);
    rerender(<PlayerBar {...baseProps({ onNextTrack: fnB })} />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const audio = container.querySelector("audio#drplay-audio") as HTMLAudioElement;
    expect(audio).toBeTruthy();
    fireEvent.ended(audio);

    expect(fnB).toHaveBeenCalledTimes(1);
    expect(fnA).not.toHaveBeenCalled();
  });

  it("on-screen Next BUTTON click calls onNextTrack", async () => {
    const onNextTrack = vi.fn();
    const { container } = render(<PlayerBar {...baseProps({ onNextTrack })} />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const nextBtn = container
      .querySelector(".lucide-skip-forward")
      ?.closest("button") as HTMLButtonElement | null;
    expect(nextBtn).toBeTruthy();
    expect(nextBtn?.disabled).toBe(false);

    fireEvent.click(nextBtn!);

    expect(onNextTrack).toHaveBeenCalledTimes(1);
  });

  it("on-screen Prev BUTTON click calls onPrevTrack", async () => {
    const onPrevTrack = vi.fn();
    const { container } = render(<PlayerBar {...baseProps({ onPrevTrack })} />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const prevBtn = container
      .querySelector(".lucide-skip-back")
      ?.closest("button") as HTMLButtonElement | null;
    expect(prevBtn).toBeTruthy();
    expect(prevBtn?.disabled).toBe(false);

    fireEvent.click(prevBtn!);

    expect(onPrevTrack).toHaveBeenCalledTimes(1);
  });
});
