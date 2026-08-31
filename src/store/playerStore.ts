import { create } from "zustand";
import type { Track, PlayMode } from "../types";

interface PlayerState {
  /** The track the player is (about to be) loaded with; null = nothing loaded. */
  currentTrack: Track | null;
  /** Bumped to force the audio element to reload the current source (replay). */
  loadNonce: number;
  /** Whether audio is currently playing (not just loaded). */
  isPlaying: boolean;
  /** Whether the player is preloading/downloading the stream of the current track. */
  isDownloading: boolean;
  /** Playback mode: normal, shuffle, repeat-all or repeat-one. */
  playMode: PlayMode;
  /** The queue as the user built it (source of truth for shuffle resets). */
  originalQueue: Track[];
  /** The queue actually played (shuffled when playMode is "shuffle"). */
  playbackQueue: Track[];

  /**
   * Track ids that failed to play in this session (AudioController emitted
   * `error` with code "format_error" — unrecoverable decode/format or network
   * give-up). The auto-advance guard in usePlayerQueue skips them so
   * repeat-all cannot loop a broken track forever.
   */
  brokenTrackIds: string[];

  /**
   * Set the current track, or update it from its previous value. Used on
   * track selection and when the next/previous button advances the queue.
   */
  setCurrentTrack: (
    track: Track | null | ((prev: Track | null) => Track | null),
  ) => void;
  /** Replay the current source: bumps loadNonce to remount the audio element. */
  triggerReload: () => void;
  /** Mark audio as playing/paused (mirrors the actual media element state). */
  setIsPlaying: (isPlaying: boolean | ((prev: boolean) => boolean)) => void;
  /** Mark the current track's stream as preloading/downloading. */
  setIsDownloading: (isDownloading: boolean) => void;
  /** Change the play mode (shuffle recomputes the playback queue downstream). */
  setPlayMode: (mode: PlayMode | ((prev: PlayMode) => PlayMode)) => void;
  /** Replace the user-ordered queue (folder load). */
  setOriginalQueue: (queue: Track[]) => void;
  /**
   * Replace the playback queue, or update it from its previous value — the
   * shuffle/skip logic uses the updater form to advance without recomputing
   * the whole queue.
   */
  setPlaybackQueue: (queue: Track[] | ((prev: Track[]) => Track[])) => void;
  /** Remember a track failed to play (unrecoverable) so auto-advance skips it. */
  markTrackBroken: (trackId: string) => void;
  /** Forget a track's failure — a user-initiated play is a fresh chance. */
  clearTrackBroken: (trackId: string) => void;
  /** Forget every failure — session cleanup on logout. */
  resetBrokenTracks: () => void;
}

/**
 * Global player state: what is loaded, whether it is playing, the play mode,
 * and the two queue layers (the user's original order vs. the shuffled
 * playback order). Decoupled from the audio element itself so any component
 * can render queue/playback UI without touching the media engine.
 */
export const usePlayerStore = create<PlayerState>((set) => ({
  currentTrack: null,
  loadNonce: 0,
  isPlaying: false,
  isDownloading: false,
  playMode: "normal",
  originalQueue: [],
  playbackQueue: [],
  brokenTrackIds: [],

  setCurrentTrack: (track) => {
    set((state) => ({
      currentTrack:
        typeof track === "function" ? track(state.currentTrack) : track,
    }));
  },
  triggerReload: () => {
    set((state) => ({ loadNonce: state.loadNonce + 1 }));
  },
  setIsPlaying: (isPlaying) => {
    set((state) => ({
      isPlaying:
        typeof isPlaying === "function"
          ? isPlaying(state.isPlaying)
          : isPlaying,
    }));
  },
  setIsDownloading: (isDownloading) => {
    set({ isDownloading });
  },
  setPlayMode: (playMode) => {
    set((state) => ({
      playMode:
        typeof playMode === "function" ? playMode(state.playMode) : playMode,
    }));
  },
  setOriginalQueue: (originalQueue) => {
    set({ originalQueue });
  },
  setPlaybackQueue: (queue) => {
    set((state) => ({
      playbackQueue:
        typeof queue === "function" ? queue(state.playbackQueue) : queue,
    }));
  },
  markTrackBroken: (trackId) => {
    set((state) => {
      if (state.brokenTrackIds.includes(trackId)) return state;
      return { brokenTrackIds: [...state.brokenTrackIds, trackId] };
    });
  },
  clearTrackBroken: (trackId) => {
    set((state) => {
      if (!state.brokenTrackIds.includes(trackId)) return state;
      return {
        brokenTrackIds: state.brokenTrackIds.filter((id) => id !== trackId),
      };
    });
  },
  resetBrokenTracks: () => {
    set({ brokenTrackIds: [] });
  },
}));
