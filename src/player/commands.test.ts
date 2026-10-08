// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioController } from "../lib/AudioController";
import { usePlayerStore } from "../store/playerStore";
import {
  guardAllowsAutoAdvance,
  noteFormatError,
  resetAdvanceGuard,
} from "../utils/playerError";
import {
  PLAYER_COMMAND_IDS,
  PLAYER_COMMANDS,
  commandById,
  findCommandForEvent,
  shortcutFor,
  type PlayerCommandContext,
  type PlayerCommandId,
} from "./commands";

const tauriMocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriMocks.invoke }));

function lastCommand(): unknown[] {
  const calls = tauriMocks.invoke.mock.calls as unknown as Array<
    [string, { cmd?: unknown[] } | undefined]
  >;
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const call = calls[i];
    if (call !== undefined && call[0] === "mpv_command") {
      return call[1]?.cmd ?? [];
    }
  }
  return [];
}

function keyEvent(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, ...init });
}

function makeCtx() {
  const audio = {
    getVolume: vi.fn(() => 0.5),
    setVolume: vi.fn(),
    toggleMute: vi.fn(() => true),
    isMuted: vi.fn(() => false),
    getCurrentTime: vi.fn(() => 100),
    getDuration: vi.fn(() => 240),
    seek: vi.fn(),
    pause: vi.fn(),
  };
  return {
    audio: audio as unknown as AudioController,
    isFullscreen: false,
    toggleFullscreen: vi.fn(),
    toggleQueue: vi.fn(),
    isQueueOpen: false,
    selectTrack: vi.fn(),
    togglePlay: vi.fn(),
    next: vi.fn(),
    previous: vi.fn(),
    togglePlayMode: vi.fn(),
    setPlayMode: vi.fn(),
    _audio: audio,
  };
}

function idFor(
  key: string,
  init: KeyboardEventInit = {},
): PlayerCommandId | undefined {
  return findCommandForEvent(keyEvent(key, init))?.id;
}

async function runCommand(id: PlayerCommandId, ctx: PlayerCommandContext) {
  await commandById(id).run(ctx);
}

const track = {
  id: "t1",
  title: "Song",
  artist: "Artist",
  streamUrl: "/drive-stream/t1",
};

beforeEach(() => {
  usePlayerStore.setState({
    currentTrack: null,
    isPlaying: false,
    playMode: "normal",
  });
  resetAdvanceGuard();
  document.body.innerHTML = "";
  tauriMocks.invoke.mockReset();
  tauriMocks.invoke.mockResolvedValue(undefined);
});

describe("commands — shortcut map", () => {
  it("covers every declared command id exactly once", () => {
    const declared = Object.values(PLAYER_COMMAND_IDS);
    const implemented = PLAYER_COMMANDS.map((command) => command.id);
    expect([...implemented].sort()).toEqual([...declared].sort());
    expect(new Set(implemented).size).toBe(implemented.length);
  });

  it.each<[string, KeyboardEventInit, PlayerCommandId]>([
    [" ", {}, PLAYER_COMMAND_IDS.PLAYER_PLAY_PAUSE],
    ["s", {}, PLAYER_COMMAND_IDS.PLAYER_STOP],
    ["S", {}, PLAYER_COMMAND_IDS.PLAYER_STOP],
    ["p", {}, PLAYER_COMMAND_IDS.PLAYER_PREVIOUS],
    ["n", {}, PLAYER_COMMAND_IDS.PLAYER_NEXT],
    ["ArrowLeft", {}, PLAYER_COMMAND_IDS.PLAYER_SEEK_BACKWARD_5],
    [
      "ArrowLeft",
      { shiftKey: true },
      PLAYER_COMMAND_IDS.PLAYER_SEEK_BACKWARD_1,
    ],
    ["ArrowRight", {}, PLAYER_COMMAND_IDS.PLAYER_SEEK_FORWARD_5],
    [
      "ArrowRight",
      { shiftKey: true },
      PLAYER_COMMAND_IDS.PLAYER_SEEK_FORWARD_1,
    ],
    ["ArrowUp", {}, PLAYER_COMMAND_IDS.PLAYER_SEEK_FORWARD_60],
    ["ArrowDown", {}, PLAYER_COMMAND_IDS.PLAYER_SEEK_BACKWARD_60],
    ["f", {}, PLAYER_COMMAND_IDS.PLAYER_FULLSCREEN],
    ["a", {}, PLAYER_COMMAND_IDS.PLAYER_AUDIO_NEXT],
    ["A", { shiftKey: true }, PLAYER_COMMAND_IDS.PLAYER_AUDIO_PREV],
    ["v", {}, PLAYER_COMMAND_IDS.PLAYER_SUBTITLE_NEXT],
    ["V", { shiftKey: true }, PLAYER_COMMAND_IDS.PLAYER_SUBTITLE_VISIBLE],
    ["m", {}, PLAYER_COMMAND_IDS.PLAYER_MUTE],
    ["ArrowUp", { ctrlKey: true }, PLAYER_COMMAND_IDS.PLAYER_VOLUME_UP],
    ["ArrowDown", { ctrlKey: true }, PLAYER_COMMAND_IDS.PLAYER_VOLUME_DOWN],
    ["g", {}, PLAYER_COMMAND_IDS.PLAYER_SUB_DELAY_DOWN],
    ["h", {}, PLAYER_COMMAND_IDS.PLAYER_SUB_DELAY_UP],
    ["H", { shiftKey: true }, PLAYER_COMMAND_IDS.PLAYER_SUB_DELAY_RESET],
    [
      "ArrowLeft",
      { ctrlKey: true, altKey: true },
      PLAYER_COMMAND_IDS.PLAYER_AUDIO_DELAY_DOWN,
    ],
    [
      "ArrowRight",
      { ctrlKey: true, altKey: true },
      PLAYER_COMMAND_IDS.PLAYER_AUDIO_DELAY_UP,
    ],
    [
      "ArrowDown",
      { ctrlKey: true, altKey: true },
      PLAYER_COMMAND_IDS.PLAYER_AUDIO_DELAY_RESET,
    ],
    ["[", {}, PLAYER_COMMAND_IDS.PLAYER_SPEED_DOWN],
    ["]", {}, PLAYER_COMMAND_IDS.PLAYER_SPEED_UP],
    ["=", {}, PLAYER_COMMAND_IDS.PLAYER_SPEED_NORMAL],
    ["r", {}, PLAYER_COMMAND_IDS.PLAYER_ASPECT_CYCLE],
    ["d", {}, PLAYER_COMMAND_IDS.PLAYER_DEINTERLACE_CYCLE],
    ["0", { ctrlKey: true }, PLAYER_COMMAND_IDS.PLAYER_FIT_WINDOW],
    ["=", { ctrlKey: true }, PLAYER_COMMAND_IDS.PLAYER_ZOOM_IN],
    ["+", { ctrlKey: true, shiftKey: true }, PLAYER_COMMAND_IDS.PLAYER_ZOOM_IN],
    ["-", { ctrlKey: true }, PLAYER_COMMAND_IDS.PLAYER_ZOOM_OUT],
    ["s", { ctrlKey: true }, PLAYER_COMMAND_IDS.PLAYER_SNAPSHOT],
    ["s", { ctrlKey: true, shiftKey: true }, PLAYER_COMMAND_IDS.PLAYER_SHUFFLE],
    ["i", {}, PLAYER_COMMAND_IDS.PLAYER_MEDIA_INFO],
    ["l", {}, PLAYER_COMMAND_IDS.PLAYER_AB_LOOP],
    ["q", { ctrlKey: true }, PLAYER_COMMAND_IDS.PLAYER_QUEUE_TOGGLE],
    ["F8", {}, PLAYER_COMMAND_IDS.PLAYER_QUEUE_TOGGLE],
    ["q", { metaKey: true }, PLAYER_COMMAND_IDS.PLAYER_QUEUE_TOGGLE],
  ])("maps %o %o -> %s", (key, init, expected) => {
    expect(idFor(key, init)).toBe(expected);
  });

  it("keeps F8 and Ctrl+Q as aliases of the same queue command (old behavior preserved)", () => {
    const f8 = findCommandForEvent(keyEvent("F8"));
    const ctrlQ = findCommandForEvent(keyEvent("q", { ctrlKey: true }));
    expect(f8).toBeDefined();
    expect(ctrlQ).toBe(f8);
    expect(f8?.id).toBe(PLAYER_COMMAND_IDS.PLAYER_QUEUE_TOGGLE);
  });

  it("distinguishes Ctrl+S (snapshot) from Ctrl+Shift+S (shuffle)", () => {
    expect(idFor("s", { ctrlKey: true })).toBe(
      PLAYER_COMMAND_IDS.PLAYER_SNAPSHOT,
    );
    expect(idFor("s", { ctrlKey: true, shiftKey: true })).toBe(
      PLAYER_COMMAND_IDS.PLAYER_SHUFFLE,
    );
  });

  it("leaves PLAYER_PLAYMODE_CYCLE without a keyboard binding (spec: F8 = queue)", () => {
    expect(shortcutFor(PLAYER_COMMAND_IDS.PLAYER_PLAYMODE_CYCLE)).toBe("");
    for (const [key, init] of [
      ["F8", {}],
      ["q", { ctrlKey: true }],
      ["s", { ctrlKey: true }],
      ["s", { ctrlKey: true, shiftKey: true }],
    ] as Array<[string, KeyboardEventInit]>) {
      expect(idFor(key, init)).not.toBe(
        PLAYER_COMMAND_IDS.PLAYER_PLAYMODE_CYCLE,
      );
    }
  });

  it("ignores unassigned modifier chords for plain keys (app/webview owns them)", () => {
    expect(idFor("n", { ctrlKey: true })).toBeUndefined();
    expect(idFor("p", { metaKey: true })).toBeUndefined();
    expect(idFor("s", { ctrlKey: true, altKey: true })).toBeUndefined();
    expect(idFor(" ", { ctrlKey: true })).toBeUndefined();
    expect(idFor(" ", { metaKey: true })).toBeUndefined();
    expect(idFor("a", { ctrlKey: true })).toBeUndefined();
  });

  it("ignores every shortcut while focus is in an editable field", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    expect(findCommandForEvent(keyEvent(" "))).toBeUndefined();
    expect(findCommandForEvent(keyEvent("ArrowRight"))).toBeUndefined();
    expect(
      findCommandForEvent(keyEvent("q", { ctrlKey: true })),
    ).toBeUndefined();
  });

  it("suppresses auto-repeat for discrete toggles but keeps it for seek/volume/speed/delay/zoom", () => {
    expect(
      findCommandForEvent(keyEvent(" ", { repeat: true })),
    ).toBeUndefined();
    expect(
      findCommandForEvent(keyEvent("n", { repeat: true })),
    ).toBeUndefined();
    expect(
      findCommandForEvent(keyEvent("q", { ctrlKey: true, repeat: true })),
    ).toBeUndefined();
    expect(
      findCommandForEvent(keyEvent("m", { repeat: true })),
    ).toBeUndefined();
    expect(idFor("ArrowRight", { repeat: true })).toBe(
      PLAYER_COMMAND_IDS.PLAYER_SEEK_FORWARD_5,
    );
    expect(idFor("ArrowUp", { ctrlKey: true, repeat: true })).toBe(
      PLAYER_COMMAND_IDS.PLAYER_VOLUME_UP,
    );
    expect(idFor("]", { repeat: true })).toBe(
      PLAYER_COMMAND_IDS.PLAYER_SPEED_UP,
    );
    expect(idFor("h", { repeat: true })).toBe(
      PLAYER_COMMAND_IDS.PLAYER_SUB_DELAY_UP,
    );
    expect(idFor("=", { ctrlKey: true, repeat: true })).toBe(
      PLAYER_COMMAND_IDS.PLAYER_ZOOM_IN,
    );
  });

  it("marks the browser-default chords for preventDefault and leaves plain letters alone", () => {
    const space = findCommandForEvent(keyEvent(" "));
    expect(space?.preventDefault).toBe(true);
    const arrow = findCommandForEvent(keyEvent("ArrowRight"));
    expect(arrow?.preventDefault).toBe(true);
    const ctrlS = findCommandForEvent(keyEvent("s", { ctrlKey: true }));
    expect(ctrlS?.preventDefault).toBe(true);
    const ctrlQ = findCommandForEvent(keyEvent("q", { ctrlKey: true }));
    expect(ctrlQ?.preventDefault).toBe(true);
    const f8 = findCommandForEvent(keyEvent("F8"));
    expect(f8?.preventDefault).toBe(true);
    const plainS = findCommandForEvent(keyEvent("s"));
    expect(plainS?.preventDefault).toBe(false);
  });

  it("exposes label keys and shortcut labels per command", () => {
    for (const command of PLAYER_COMMANDS) {
      expect(command.labelKey.startsWith("player.command.")).toBe(true);
      // Unbound commands (playmode cycle) carry an empty label — every other
      // command must show its shortcut.
      if (command.id !== PLAYER_COMMAND_IDS.PLAYER_PLAYMODE_CYCLE) {
        expect(command.shortcut.length).toBeGreaterThan(0);
      }
    }
    expect(shortcutFor(PLAYER_COMMAND_IDS.PLAYER_PLAY_PAUSE)).toBe("Space");
    expect(shortcutFor(PLAYER_COMMAND_IDS.PLAYER_VOLUME_UP)).toBe("Ctrl+Up");
    expect(shortcutFor(PLAYER_COMMAND_IDS.PLAYER_SUB_DELAY_RESET)).toBe(
      "Shift+H",
    );
    expect(shortcutFor(PLAYER_COMMAND_IDS.PLAYER_QUEUE_TOGGLE)).toBe("F8");
    expect(shortcutFor(PLAYER_COMMAND_IDS.PLAYER_SHUFFLE)).toBe("Ctrl+Shift+S");
  });
});

describe("commands — run() behavior", () => {
  it("PLAY_PAUSE resets the storm guard and delegates to ctx.togglePlay", async () => {
    const ctx = makeCtx();
    for (let i = 0; i < 3; i++) noteFormatError(Date.now());
    expect(guardAllowsAutoAdvance(Date.now())).toBe(false);

    await runCommand(PLAYER_COMMAND_IDS.PLAYER_PLAY_PAUSE, ctx);

    expect(ctx.togglePlay).toHaveBeenCalledTimes(1);
    expect(guardAllowsAutoAdvance(Date.now())).toBe(true);
  });

  it("NEXT / PREVIOUS reset the storm guard and delegate to ctx.next/previous", async () => {
    const ctx = makeCtx();
    for (let i = 0; i < 3; i++) noteFormatError(Date.now());
    await runCommand(PLAYER_COMMAND_IDS.PLAYER_NEXT, ctx);
    expect(ctx.next).toHaveBeenCalledTimes(1);
    expect(guardAllowsAutoAdvance(Date.now())).toBe(true);

    for (let i = 0; i < 3; i++) noteFormatError(Date.now());
    await runCommand(PLAYER_COMMAND_IDS.PLAYER_PREVIOUS, ctx);
    expect(ctx.previous).toHaveBeenCalledTimes(1);
    expect(guardAllowsAutoAdvance(Date.now())).toBe(true);
  });

  it("STOP is a no-op without a current track and pauses + seeks to 0 with one", async () => {
    const empty = makeCtx();
    await runCommand(PLAYER_COMMAND_IDS.PLAYER_STOP, empty);
    expect(empty._audio.pause).not.toHaveBeenCalled();
    expect(empty._audio.seek).not.toHaveBeenCalled();

    usePlayerStore.setState({ currentTrack: track });
    const ctx = makeCtx();
    await runCommand(PLAYER_COMMAND_IDS.PLAYER_STOP, ctx);
    expect(ctx._audio.pause).toHaveBeenCalledTimes(1);
    expect(ctx._audio.seek).toHaveBeenCalledWith(0);
  });

  it("seek commands use the shared relative-seek guard (duration <= 0 no-ops)", async () => {
    const ctx = makeCtx();
    await runCommand(PLAYER_COMMAND_IDS.PLAYER_SEEK_FORWARD_5, ctx);
    expect(ctx._audio.seek).toHaveBeenCalledWith(105);
    ctx._audio.seek.mockClear();

    await runCommand(PLAYER_COMMAND_IDS.PLAYER_SEEK_BACKWARD_1, ctx);
    expect(ctx._audio.seek).toHaveBeenCalledWith(99);
    ctx._audio.seek.mockClear();

    await runCommand(PLAYER_COMMAND_IDS.PLAYER_SEEK_FORWARD_60, ctx);
    expect(ctx._audio.seek).toHaveBeenCalledWith(160);
    ctx._audio.seek.mockClear();

    ctx._audio.getDuration.mockReturnValue(0);
    await runCommand(PLAYER_COMMAND_IDS.PLAYER_SEEK_BACKWARD_60, ctx);
    expect(ctx._audio.seek).not.toHaveBeenCalled();
  });

  it("volume commands mirror the VolumeSlider semantics (0..1, step 0.1, no unmute)", async () => {
    const ctx = makeCtx();
    await runCommand(PLAYER_COMMAND_IDS.PLAYER_VOLUME_UP, ctx);
    expect(ctx._audio.setVolume).toHaveBeenCalledWith(0.6);
    expect(ctx._audio.toggleMute).not.toHaveBeenCalled();

    ctx._audio.getVolume.mockReturnValue(1);
    await runCommand(PLAYER_COMMAND_IDS.PLAYER_VOLUME_UP, ctx);
    expect(ctx._audio.setVolume).toHaveBeenLastCalledWith(1);

    ctx._audio.getVolume.mockReturnValue(0.05);
    await runCommand(PLAYER_COMMAND_IDS.PLAYER_VOLUME_DOWN, ctx);
    expect(ctx._audio.setVolume).toHaveBeenLastCalledWith(0);
  });

  it("MUTE / FULLSCREEN / QUEUE_TOGGLE / PLAYMODE_CYCLE delegate to their ctx callbacks", async () => {
    const ctx = makeCtx();
    await runCommand(PLAYER_COMMAND_IDS.PLAYER_MUTE, ctx);
    expect(ctx._audio.toggleMute).toHaveBeenCalledTimes(1);

    await runCommand(PLAYER_COMMAND_IDS.PLAYER_FULLSCREEN, ctx);
    expect(ctx.toggleFullscreen).toHaveBeenCalledTimes(1);

    await runCommand(PLAYER_COMMAND_IDS.PLAYER_QUEUE_TOGGLE, ctx);
    expect(ctx.toggleQueue).toHaveBeenCalledTimes(1);

    await runCommand(PLAYER_COMMAND_IDS.PLAYER_PLAYMODE_CYCLE, ctx);
    expect(ctx.togglePlayMode).toHaveBeenCalledTimes(1);
  });

  it("SHUFFLE toggles playMode between shuffle and normal via ctx.setPlayMode", async () => {
    const ctx = makeCtx();
    usePlayerStore.setState({ playMode: "normal" });
    await runCommand(PLAYER_COMMAND_IDS.PLAYER_SHUFFLE, ctx);
    expect(ctx.setPlayMode).toHaveBeenCalledWith("shuffle");

    usePlayerStore.setState({ playMode: "shuffle" });
    await runCommand(PLAYER_COMMAND_IDS.PLAYER_SHUFFLE, ctx);
    expect(ctx.setPlayMode).toHaveBeenLastCalledWith("normal");

    // From any other mode the toggle enters shuffle (only shuffle/normal pair).
    usePlayerStore.setState({ playMode: "repeat-all" });
    await runCommand(PLAYER_COMMAND_IDS.PLAYER_SHUFFLE, ctx);
    expect(ctx.setPlayMode).toHaveBeenLastCalledWith("shuffle");
  });

  it("AUDIO_DELAY_DOWN/UP/RESET nudge mpv audio-delay by 100 ms and reset it", async () => {
    const ctx = makeCtx();

    await runCommand(PLAYER_COMMAND_IDS.PLAYER_AUDIO_DELAY_DOWN, ctx);
    expect(lastCommand()).toEqual(["add", "audio-delay", "-0.1"]);

    await runCommand(PLAYER_COMMAND_IDS.PLAYER_AUDIO_DELAY_UP, ctx);
    expect(lastCommand()).toEqual(["add", "audio-delay", "0.1"]);

    await runCommand(PLAYER_COMMAND_IDS.PLAYER_AUDIO_DELAY_RESET, ctx);
    expect(lastCommand()).toEqual(["set_property", "audio-delay", "0"]);
  });

  it("audio-delay chords are repeatable (held keys keep nudging) and prevent the default", () => {
    const down = findCommandForEvent(
      keyEvent("ArrowLeft", { ctrlKey: true, altKey: true, repeat: true }),
    );
    expect(down?.id).toBe(PLAYER_COMMAND_IDS.PLAYER_AUDIO_DELAY_DOWN);
    expect(down?.repeatable).toBe(true);
    expect(down?.preventDefault).toBe(true);
  });
});

afterEach(() => {
  usePlayerStore.setState({
    currentTrack: null,
    isPlaying: false,
    playMode: "normal",
  });
});
