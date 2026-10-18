import type { AudioController } from "../../lib/AudioController";
import type { PlayMode, Track } from "../../types";

export const PLAYER_COMMAND_IDS = {
  PLAYER_PLAY_PAUSE: "PLAYER_PLAY_PAUSE",
  PLAYER_STOP: "PLAYER_STOP",
  PLAYER_PREVIOUS: "PLAYER_PREVIOUS",
  PLAYER_NEXT: "PLAYER_NEXT",
  PLAYER_SEEK_FORWARD_5: "PLAYER_SEEK_FORWARD_5",
  PLAYER_SEEK_BACKWARD_5: "PLAYER_SEEK_BACKWARD_5",
  PLAYER_SEEK_FORWARD_1: "PLAYER_SEEK_FORWARD_1",
  PLAYER_SEEK_BACKWARD_1: "PLAYER_SEEK_BACKWARD_1",
  PLAYER_SEEK_FORWARD_60: "PLAYER_SEEK_FORWARD_60",
  PLAYER_SEEK_BACKWARD_60: "PLAYER_SEEK_BACKWARD_60",
  PLAYER_FULLSCREEN: "PLAYER_FULLSCREEN",
  PLAYER_AUDIO_NEXT: "PLAYER_AUDIO_NEXT",
  PLAYER_AUDIO_PREV: "PLAYER_AUDIO_PREV",
  PLAYER_SUBTITLE_NEXT: "PLAYER_SUBTITLE_NEXT",
  PLAYER_SUBTITLE_VISIBLE: "PLAYER_SUBTITLE_VISIBLE",
  PLAYER_MUTE: "PLAYER_MUTE",
  PLAYER_VOLUME_UP: "PLAYER_VOLUME_UP",
  PLAYER_VOLUME_DOWN: "PLAYER_VOLUME_DOWN",
  PLAYER_SPEED_DOWN: "PLAYER_SPEED_DOWN",
  PLAYER_SPEED_UP: "PLAYER_SPEED_UP",
  PLAYER_SPEED_NORMAL: "PLAYER_SPEED_NORMAL",
  PLAYER_SUB_DELAY_DOWN: "PLAYER_SUB_DELAY_DOWN",
  PLAYER_SUB_DELAY_UP: "PLAYER_SUB_DELAY_UP",
  PLAYER_SUB_DELAY_RESET: "PLAYER_SUB_DELAY_RESET",
  PLAYER_AUDIO_DELAY_DOWN: "PLAYER_AUDIO_DELAY_DOWN",
  PLAYER_AUDIO_DELAY_UP: "PLAYER_AUDIO_DELAY_UP",
  PLAYER_AUDIO_DELAY_RESET: "PLAYER_AUDIO_DELAY_RESET",
  PLAYER_ASPECT_CYCLE: "PLAYER_ASPECT_CYCLE",
  PLAYER_DEINTERLACE_CYCLE: "PLAYER_DEINTERLACE_CYCLE",
  PLAYER_FIT_WINDOW: "PLAYER_FIT_WINDOW",
  PLAYER_ZOOM_IN: "PLAYER_ZOOM_IN",
  PLAYER_ZOOM_OUT: "PLAYER_ZOOM_OUT",
  PLAYER_SNAPSHOT: "PLAYER_SNAPSHOT",
  PLAYER_MEDIA_INFO: "PLAYER_MEDIA_INFO",
  PLAYER_AB_LOOP: "PLAYER_AB_LOOP",
  PLAYER_QUEUE_TOGGLE: "PLAYER_QUEUE_TOGGLE",
  PLAYER_PLAYMODE_CYCLE: "PLAYER_PLAYMODE_CYCLE",
  PLAYER_SHUFFLE: "PLAYER_SHUFFLE",
} as const;

export type PlayerCommandId =
  (typeof PLAYER_COMMAND_IDS)[keyof typeof PLAYER_COMMAND_IDS];

/**
 * Live player surface the commands act on. Built by App from the callbacks it
 * already passes to the PlayerBar/NowPlaying controls (no parallel wiring);
 * playback state (isPlaying, playMode, queue) is read from the store inside
 * `run` so this object never needs to be a render dependency.
 */
export interface PlayerCommandContext {
  audio: AudioController;
  isFullscreen: boolean;
  toggleFullscreen: () => void;
  toggleQueue: () => void;
  isQueueOpen: boolean;
  selectTrack: (track: Track) => void;
  togglePlay: () => void;
  next: () => void;
  previous: () => void;
  togglePlayMode: () => void;
  setPlayMode: (mode: PlayMode) => void;
  /**
   * Player activity just happened (Slice 1/C). Optional so every other caller
   * (tests, the menu, a surface without a fullscreen bar) keeps working
   * unchanged. It is NOT a shortcut and NOT a second keyboard handler: it is
   * notified from the single `runPlayerCommand` entry point, so it fires
   * exactly once per executed command regardless of which surface triggered
   * it, and it can never swallow or duplicate the command.
   */
  onActivity?: (() => void) | undefined;
}

export interface PlayerCommand {
  id: PlayerCommandId;
  /** i18n key used by the menu (D2b) — label lives in the locale files only. */
  labelKey: string;
  /** Shortcut label for display (menu/tooltips) — e.g. "Space", "Ctrl+Up". */
  shortcut: string;
  match: (event: KeyboardEvent) => boolean;
  run: (ctx: PlayerCommandContext) => Promise<void> | void;
  /** Cancel the browser/webview default for chords that would act on it. */
  preventDefault?: boolean;
  /** Held-key auto-repeat: only seek/volume/speed/delay/zoom opt in. */
  repeatable?: boolean;
}
