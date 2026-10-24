import i18next from "i18next";
import { seekRelative, SEEK_STEP_SECONDS } from "../../hooks/player/utils";
import {
  addAudioDelay,
  addSubDelay,
  addVideoZoom,
  aspectCycleValue,
  clearAbLoop,
  deinterlaceCycle,
  getAbLoop,
  getAspectOverride,
  getDeinterlace,
  getSpeed,
  getTrackList,
  nextTrackId,
  resetAudioDelay,
  resetSubDelay,
  resetVideoView,
  setAbLoopA,
  setAbLoopB,
  setAspectOverride,
  setAudioTrack,
  setDeinterlace,
  setSpeed,
  setSubtitleTrack,
  SPEED_NORMAL,
  speedStep,
  takeScreenshot,
  toggleSubtitleVisibility,
} from "../../lib/mpvControl";
import { usePlayerStore } from "../../store/playerStore";
import { resetAdvanceGuard } from "../../utils/playerError";
import {
  PLAYER_COMMAND_IDS,
  type PlayerCommand,
  type PlayerCommandContext,
} from "./ids";
import { emitPlayerUi } from "../playerUiBus";

/** Volume nudge per keypress — same 0.1 step the VolumeSlider drag uses. */
export const VOLUME_STEP = 0.1;
/** Fine seek step (Shift+Arrow). */
const SEEK_STEP_FINE_SECONDS = 1;
/** Long seek step (Shift+ArrowUp/Down). */
const SEEK_STEP_LARGE_SECONDS = 60;
/** Subtitle/audio delay nudge per keypress (VLC-style 50 ms). */
const SUB_DELAY_STEP_SECONDS = 0.05;
/** Audio delay nudge per keypress (spec §4: 100 ms). */
const AUDIO_DELAY_STEP_SECONDS = 0.1;
/** mpv `video-zoom` nudge per keypress. */
export const VIDEO_ZOOM_STEP = 0.1;

function noModifiers(event: KeyboardEvent): boolean {
  return !event.ctrlKey && !event.metaKey && !event.altKey;
}

function commandModifier(event: KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey;
}

/** Ctrl+Alt chord: the audio-delay trio (disjoint from every other matcher). */
function audioDelayModifier(event: KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && event.altKey;
}

function adjustVolume(ctx: PlayerCommandContext, direction: 1 | -1): void {
  const next = Math.max(
    0,
    Math.min(1, ctx.audio.getVolume() + direction * VOLUME_STEP),
  );
  ctx.audio.setVolume(next);
  emitPlayerUi("volume-changed", {
    volume: next,
    muted: ctx.audio.isMuted(),
  });
}

async function selectAdjacentTrack(
  type: "audio" | "sub",
  direction: 1 | -1,
  apply: (id: number) => Promise<void>,
): Promise<void> {
  const tracks = (await getTrackList()).filter((track) => track.type === type);
  const currentId = tracks.find((track) => track.selected)?.id ?? null;
  const nextId = nextTrackId(tracks, currentId, direction);
  if (nextId === null) return;
  await apply(nextId);
}

export const COMMAND_DEFINITIONS: readonly PlayerCommand[] = [
  {
    id: PLAYER_COMMAND_IDS.PLAYER_PLAY_PAUSE,
    labelKey: "player.command.play_pause",
    shortcut: "Space",
    preventDefault: true,
    match: (e) => noModifiers(e) && e.key === " ",
    run: (ctx) => {
      // Manual transport action: same storm-guard reset the PlayerBar buttons
      // apply (Fix I: buttons + keyboard reset, auto-advance does not).
      resetAdvanceGuard();
      ctx.togglePlay();
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_STOP,
    labelKey: "player.command.stop",
    shortcut: "S",
    preventDefault: false,
    match: (e) => noModifiers(e) && e.key.toLowerCase() === "s",
    run: (ctx) => {
      // No live track: pausing would latch the engine's pause intent onto the
      // NEXT load — stop must stay a no-op (mirror of the engine's seek guard).
      if (!usePlayerStore.getState().currentTrack) return;
      ctx.audio.pause();
      ctx.audio.seek(0);
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_PREVIOUS,
    labelKey: "player.command.previous",
    shortcut: "P",
    preventDefault: false,
    match: (e) => noModifiers(e) && e.key.toLowerCase() === "p",
    run: (ctx) => {
      resetAdvanceGuard();
      ctx.previous();
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_NEXT,
    labelKey: "player.command.next",
    shortcut: "N",
    preventDefault: false,
    match: (e) => noModifiers(e) && e.key.toLowerCase() === "n",
    run: (ctx) => {
      resetAdvanceGuard();
      ctx.next();
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_SEEK_FORWARD_5,
    labelKey: "player.command.seek_forward_5",
    shortcut: "\u2192 5s",
    preventDefault: true,
    repeatable: true,
    match: (e) => noModifiers(e) && !e.shiftKey && e.key === "ArrowRight",
    run: (ctx) => {
      seekRelative(ctx.audio, SEEK_STEP_SECONDS);
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_SEEK_BACKWARD_5,
    labelKey: "player.command.seek_backward_5",
    shortcut: "\u2190 5s",
    preventDefault: true,
    repeatable: true,
    match: (e) => noModifiers(e) && !e.shiftKey && e.key === "ArrowLeft",
    run: (ctx) => {
      seekRelative(ctx.audio, -SEEK_STEP_SECONDS);
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_SEEK_FORWARD_1,
    labelKey: "player.command.seek_forward_1",
    shortcut: "Shift+\u2192 1s",
    preventDefault: true,
    repeatable: true,
    match: (e) => noModifiers(e) && e.shiftKey && e.key === "ArrowRight",
    run: (ctx) => {
      seekRelative(ctx.audio, SEEK_STEP_FINE_SECONDS);
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_SEEK_BACKWARD_1,
    labelKey: "player.command.seek_backward_1",
    shortcut: "Shift+\u2190 1s",
    preventDefault: true,
    repeatable: true,
    match: (e) => noModifiers(e) && e.shiftKey && e.key === "ArrowLeft",
    run: (ctx) => {
      seekRelative(ctx.audio, -SEEK_STEP_FINE_SECONDS);
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_SEEK_FORWARD_60,
    labelKey: "player.command.seek_forward_60",
    shortcut: "Shift+\u2191 60s",
    preventDefault: true,
    repeatable: true,
    match: (e) => noModifiers(e) && e.shiftKey && e.key === "ArrowUp",
    run: (ctx) => {
      seekRelative(ctx.audio, SEEK_STEP_LARGE_SECONDS);
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_SEEK_BACKWARD_60,
    labelKey: "player.command.seek_backward_60",
    shortcut: "Shift+\u2193 60s",
    preventDefault: true,
    repeatable: true,
    match: (e) => noModifiers(e) && e.shiftKey && e.key === "ArrowDown",
    run: (ctx) => {
      seekRelative(ctx.audio, -SEEK_STEP_LARGE_SECONDS);
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_FULLSCREEN,
    labelKey: "player.command.fullscreen",
    shortcut: "F",
    preventDefault: false,
    match: (e) => noModifiers(e) && e.key.toLowerCase() === "f",
    run: (ctx) => {
      ctx.toggleFullscreen();
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_AUDIO_NEXT,
    labelKey: "player.command.audio_next",
    shortcut: "A",
    preventDefault: false,
    match: (e) => noModifiers(e) && !e.shiftKey && e.key.toLowerCase() === "a",
    run: async () => {
      await selectAdjacentTrack("audio", 1, setAudioTrack);
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_AUDIO_PREV,
    labelKey: "player.command.audio_prev",
    shortcut: "Shift+A",
    preventDefault: false,
    match: (e) => noModifiers(e) && e.shiftKey && e.key.toLowerCase() === "a",
    run: async () => {
      await selectAdjacentTrack("audio", -1, setAudioTrack);
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_SUBTITLE_NEXT,
    labelKey: "player.command.subtitle_next",
    shortcut: "V",
    preventDefault: false,
    match: (e) => noModifiers(e) && !e.shiftKey && e.key.toLowerCase() === "v",
    run: async () => {
      await selectAdjacentTrack("sub", 1, setSubtitleTrack);
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_SUBTITLE_VISIBLE,
    labelKey: "player.command.subtitle_visible",
    shortcut: "Shift+V",
    preventDefault: false,
    match: (e) => noModifiers(e) && e.shiftKey && e.key.toLowerCase() === "v",
    run: async () => {
      await toggleSubtitleVisibility();
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_MUTE,
    labelKey: "player.command.mute",
    shortcut: "M",
    preventDefault: false,
    match: (e) => noModifiers(e) && e.key.toLowerCase() === "m",
    run: (ctx) => {
      ctx.audio.toggleMute();
      emitPlayerUi("volume-changed", {
        volume: ctx.audio.getVolume(),
        muted: ctx.audio.isMuted(),
      });
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_VOLUME_UP,
    labelKey: "player.command.volume_up",
    shortcut: "\u2191 / Ctrl+\u2191",
    preventDefault: true,
    repeatable: true,
    match: (e) =>
      (noModifiers(e) || commandModifier(e)) &&
      !e.shiftKey &&
      e.key === "ArrowUp",
    run: (ctx) => {
      adjustVolume(ctx, 1);
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_VOLUME_DOWN,
    labelKey: "player.command.volume_down",
    shortcut: "\u2193 / Ctrl+\u2193",
    preventDefault: true,
    repeatable: true,
    match: (e) =>
      (noModifiers(e) || commandModifier(e)) &&
      !e.shiftKey &&
      e.key === "ArrowDown",
    run: (ctx) => {
      adjustVolume(ctx, -1);
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_SPEED_DOWN,
    labelKey: "player.command.speed_down",
    shortcut: "[",
    preventDefault: false,
    repeatable: true,
    match: (e) => noModifiers(e) && e.key === "[",
    run: async () => {
      await setSpeed(speedStep(await getSpeed(), -1));
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_SPEED_UP,
    labelKey: "player.command.speed_up",
    shortcut: "]",
    preventDefault: false,
    repeatable: true,
    match: (e) => noModifiers(e) && e.key === "]",
    run: async () => {
      await setSpeed(speedStep(await getSpeed(), 1));
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_SPEED_NORMAL,
    labelKey: "player.command.speed_normal",
    shortcut: "=",
    preventDefault: false,
    match: (e) => noModifiers(e) && e.key === "=",
    run: async () => {
      await setSpeed(SPEED_NORMAL);
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_SUB_DELAY_DOWN,
    labelKey: "player.command.sub_delay_down",
    shortcut: "G",
    preventDefault: false,
    repeatable: true,
    match: (e) => noModifiers(e) && !e.shiftKey && e.key.toLowerCase() === "g",
    run: async () => {
      await addSubDelay(-SUB_DELAY_STEP_SECONDS);
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_SUB_DELAY_UP,
    labelKey: "player.command.sub_delay_up",
    shortcut: "H",
    preventDefault: false,
    repeatable: true,
    match: (e) => noModifiers(e) && !e.shiftKey && e.key.toLowerCase() === "h",
    run: async () => {
      await addSubDelay(SUB_DELAY_STEP_SECONDS);
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_SUB_DELAY_RESET,
    labelKey: "player.command.sub_delay_reset",
    shortcut: "Shift+H",
    preventDefault: false,
    match: (e) => noModifiers(e) && e.shiftKey && e.key.toLowerCase() === "h",
    run: async () => {
      await resetSubDelay();
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_AUDIO_DELAY_DOWN,
    labelKey: "player.command.audio_delay_down",
    shortcut: "Ctrl+Alt+Left",
    preventDefault: true,
    repeatable: true,
    match: (e) => audioDelayModifier(e) && e.key === "ArrowLeft",
    run: async () => {
      await addAudioDelay(-AUDIO_DELAY_STEP_SECONDS);
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_AUDIO_DELAY_UP,
    labelKey: "player.command.audio_delay_up",
    shortcut: "Ctrl+Alt+Right",
    preventDefault: true,
    repeatable: true,
    match: (e) => audioDelayModifier(e) && e.key === "ArrowRight",
    run: async () => {
      await addAudioDelay(AUDIO_DELAY_STEP_SECONDS);
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_AUDIO_DELAY_RESET,
    labelKey: "player.command.audio_delay_reset",
    shortcut: "Ctrl+Alt+Down",
    preventDefault: true,
    match: (e) => audioDelayModifier(e) && e.key === "ArrowDown",
    run: async () => {
      await resetAudioDelay();
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_ASPECT_CYCLE,
    labelKey: "player.command.aspect_cycle",
    shortcut: "R",
    preventDefault: false,
    match: (e) => noModifiers(e) && e.key.toLowerCase() === "r",
    run: async () => {
      await setAspectOverride(aspectCycleValue(await getAspectOverride()));
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_DEINTERLACE_CYCLE,
    labelKey: "player.command.deinterlace_cycle",
    shortcut: "D",
    preventDefault: false,
    match: (e) => noModifiers(e) && e.key.toLowerCase() === "d",
    run: async () => {
      await setDeinterlace(deinterlaceCycle(await getDeinterlace()));
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_FIT_WINDOW,
    labelKey: "player.command.fit_window",
    shortcut: "Ctrl+0",
    preventDefault: true,
    match: (e) => commandModifier(e) && e.key === "0",
    run: async () => {
      await resetVideoView();
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_ZOOM_IN,
    labelKey: "player.command.zoom_in",
    shortcut: "Ctrl+=",
    preventDefault: true,
    repeatable: true,
    // Both Ctrl+= and Ctrl+Shift+= (which reports "+") zoom in: the shifted
    // chord is what a US layout produces when Shift is held by muscle memory.
    match: (e) => commandModifier(e) && (e.key === "=" || e.key === "+"),
    run: async () => {
      await addVideoZoom(VIDEO_ZOOM_STEP);
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_ZOOM_OUT,
    labelKey: "player.command.zoom_out",
    shortcut: "Ctrl+-",
    preventDefault: true,
    repeatable: true,
    match: (e) => commandModifier(e) && e.key === "-",
    run: async () => {
      await addVideoZoom(-VIDEO_ZOOM_STEP);
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_SNAPSHOT,
    labelKey: "player.command.snapshot",
    shortcut: "Ctrl+S",
    preventDefault: true,
    // Shift is reserved for PLAYER_SHUFFLE (Ctrl+Shift+S) — keep the matchers
    // disjoint so Ctrl+Shift+S can never take a screenshot.
    match: (e) =>
      commandModifier(e) && !e.shiftKey && e.key.toLowerCase() === "s",
    run: async () => {
      await takeScreenshot();
      emitPlayerUi("toast", {
        variant: "success",
        message: i18next.t("player.command.snapshot_saved"),
      });
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_MEDIA_INFO,
    labelKey: "player.command.media_info",
    shortcut: "I",
    preventDefault: false,
    match: (e) => noModifiers(e) && e.key.toLowerCase() === "i",
    run: () => {
      // D2b subscribes and opens the Media Info dialog.
      emitPlayerUi("media-info");
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_AB_LOOP,
    labelKey: "player.command.ab_loop",
    shortcut: "L",
    preventDefault: false,
    match: (e) => noModifiers(e) && e.key.toLowerCase() === "l",
    run: async (ctx) => {
      // Three-state cycle: set A -> set B -> clear. The current media time is
      // the engine's clock, so each press pins the point the user is hearing.
      const loop = await getAbLoop();
      if (loop.a === null) {
        await setAbLoopA(ctx.audio.getCurrentTime());
        emitPlayerUi("toast", {
          variant: "success",
          message: i18next.t("player.command.ab_loop_a_set"),
        });
        return;
      }
      if (loop.b === null) {
        await setAbLoopB(ctx.audio.getCurrentTime());
        emitPlayerUi("toast", {
          variant: "success",
          message: i18next.t("player.command.ab_loop_b_set"),
        });
        return;
      }
      await clearAbLoop();
      emitPlayerUi("toast", {
        variant: "success",
        message: i18next.t("player.command.ab_loop_cleared"),
      });
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_QUEUE_TOGGLE,
    labelKey: "player.command.queue_toggle",
    // F8 is the canonical binding (spec §8/§11); Ctrl+Q is kept as an alias
    // of this SAME command so the old shortcut keeps its exact behavior.
    shortcut: "F8",
    preventDefault: true,
    match: (e) =>
      (noModifiers(e) && e.key === "F8") ||
      (commandModifier(e) && e.key.toLowerCase() === "q"),
    run: (ctx) => {
      ctx.toggleQueue();
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_PLAYMODE_CYCLE,
    labelKey: "player.command.playmode_cycle",
    // No keyboard binding (spec §8 gives F8 to the queue) — the command stays
    // defined for the D2b menu, which runs it through runPlayerCommand.
    shortcut: "",
    preventDefault: false,
    match: () => false,
    run: (ctx) => {
      // Reuses App's NEXT_MODE handler (usePlayerQueue.handleTogglePlayMode).
      ctx.togglePlayMode();
    },
  },
  {
    id: PLAYER_COMMAND_IDS.PLAYER_SHUFFLE,
    labelKey: "player.command.shuffle",
    shortcut: "Ctrl+Shift+S",
    preventDefault: true,
    match: (e) =>
      commandModifier(e) && e.shiftKey && e.key.toLowerCase() === "s",
    run: (ctx) => {
      // Toggle shuffle on/off through App's handleSetPlayMode, which rebuilds
      // the playback queue with the existing shuffle logic — no new logic here.
      const { playMode } = usePlayerStore.getState();
      ctx.setPlayMode(playMode === "shuffle" ? "normal" : "shuffle");
    },
  },
];
