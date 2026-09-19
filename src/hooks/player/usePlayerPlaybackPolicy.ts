import { useEffect, useRef } from "react";
import { AudioController } from "../../lib/AudioController";
import { isForeignTrackEvent } from "../../lib/audioNativeEvents";
import { usePlayerStore } from "../../store/playerStore";
import { commitIsPlaying } from "../../store/playbackCommit";
import {
  guardAllowsAutoAdvance,
  noteFormatError,
  resetAdvanceGuard,
  STORM_COOLDOWN_MS,
} from "../../utils/playerError";
import { beginIntent } from "./playbackIntent";

export interface PlayerPlaybackPolicyOptions {
  /**
   * Auto-advance handler — usePlayerQueue.handleNextTrack, the same function
   * App passes down as PlayerBar's onNextTrack prop. The policy and the manual
   * transport therefore share one queue implementation.
   */
  onNextTrack: () => void;
}

/**
 * Playback policy (RC-5 / R2.3): owns the engine-event decisions that used to
 * live in PlayerBar — mark-broken, the auto-advance storm guard, errorInfo
 * writes, repeat-one replay and the storm banner cooldown timer. Mounted ONCE
 * at app level (usePlayer), so the policy no longer depends on a mounted (or
 * even rendered) PlayerBar.
 *
 * Every handler replicates the former PlayerBar handler verbatim: same
 * conditions, same order of side effects, same store values. Identity
 * filtering (R2.1) and the play-event guard reset are preserved. Manual
 * transport actions (buttons/keyboard/media keys/retry) keep resetting the
 * guard at their entry points — this hook only drives the guard from engine
 * events, as PlayerBar did.
 */
export function usePlayerPlaybackPolicy({
  onNextTrack,
}: PlayerPlaybackPolicyOptions): void {
  const audio = AudioController.getInstance();

  // The subscription is created once and must always call the FRESHEST
  // handler: onNextTrack is recreated whenever the queue/track/mode changes
  // (usePlayerQueue useCallback deps), so it is read through a ref (the same
  // ref-delegate pattern App used for the stable PlayerBar prop) — never a
  // stale queue closure.
  const onNextTrackRef = useRef(onNextTrack);
  useEffect(() => {
    onNextTrackRef.current = onNextTrack;
  }, [onNextTrack]);

  // R2.1: every handler reads the event's engine identity and drops events of
  // a DIFFERENT track than the store's current one — in the switch window
  // (store already on B, engine still emitting A's terminal events) the old
  // track's error/ended/play must not mark B broken, advance past B, clear
  // B's banner or stop B's playback. Untagged events (no identity) keep legacy
  // behavior, as does a missing current track.
  useEffect(() => {
    const isForeign = (payload: { trackId?: string } | undefined) =>
      isForeignTrackEvent(payload, usePlayerStore.getState().currentTrack?.id);
    const unsubErr = audio.on("error", (err) => {
      if (isForeign(err)) return;
      // Task D: an unrecoverable playback failure (format_error — broken
      // format/decode or retry give-up) marks the current track broken so the
      // auto-advance guard in usePlayerQueue skips it instead of looping it
      // forever under repeat-all. AudioController emits `error` BEFORE
      // `ended`, so the mark lands while the store still points at the failed
      // track. Read the store rather than a prop: this subscription is
      // memoized and must not close over a stale track.
      if (err.code === "format_error") {
        const { currentTrack: current, markTrackBroken } =
          usePlayerStore.getState();
        if (current) markTrackBroken(current.id);

        // Fix I: count the failure against the shared storm window
        // (utils/playerError). A tripped/blocked guard shows the clear storm
        // banner instead of the per-track error, which the next track change
        // would clear before it can be read.
        if (noteFormatError(Date.now())) {
          usePlayerStore.getState().setErrorInfo({
            code: "advance_stopped",
            message: "Drive is overloaded or locked — auto-playback paused.",
          });
          return;
        }
      }
      // Store only the UI surface — the engine identity is not part of it.
      usePlayerStore
        .getState()
        .setErrorInfo({ code: err.code, message: err.message });
    });
    // A `play` event is the native "playback actually resumed" signal — it
    // fires after a successful auto-retry, so the stale error banner (and its
    // RefreshCw button) must not outlive the recovery. Fix I: a successful
    // play also proves the storm is over — reset the counter and unblock.
    const unsubPlay = audio.on("play", (identity) => {
      if (isForeign(identity)) return;
      resetAdvanceGuard();
      usePlayerStore.getState().setErrorInfo(null);
    });
    const unsubEnded = audio.on("ended", (identity) => {
      if (isForeign(identity)) return;
      // Fix I: while a format_error storm is blocked, an `ended` must NOT
      // auto-advance — the next track would only fail again. Stop playback
      // instead; the storm banner (set by the error handler) stays visible
      // because the current track is no longer replaced. A natural
      // track-completion `ended` (no format_error in between) never trips the
      // guard — the counter only grows from the error subscription.
      if (!guardAllowsAutoAdvance(Date.now())) {
        commitIsPlaying("policy", false);
        return;
      }
      // Repeat-one parity: the mpv engine has no loop property and
      // resolveNextTrack never returns the current track for this mode, so the
      // ended handler must replay the same track itself (playbackFinished is
      // true after EOF, so playTrack falls through to a loadfile replace from
      // 0 instead of the same-track no-op). Read the store, not a prop: the
      // subscription is memoized and must not close over a stale track/mode.
      const { playMode, currentTrack: cur } = usePlayerStore.getState();
      if (playMode === "repeat-one" && cur) {
        void audio.playTrack(cur, 0);
        return;
      }
      // R3.1a: auto-advance is a SYSTEM intent. While a user intent is in
      // flight (e.g. a click awaiting its token), it must not invalidate it —
      // the user's track commits when the token resolves (contract (a),
      // audit B5-4). The controller refuses the handle in that window.
      const intent = beginIntent("auto-advance");
      if (!intent.isCurrent()) return;
      try {
        onNextTrackRef.current();
      } finally {
        intent.end();
      }
    });

    return () => {
      unsubErr();
      unsubPlay();
      unsubEnded();
    };
  }, [audio]);

  // F8-3: the storm banner must not outlive its cooldown. Arm one timer while
  // the banner is up — a new storm error re-publishes errorInfo, which re-arms
  // the timer, so the banner lives exactly STORM_COOLDOWN_MS since the last
  // failure and then re-arms the guard (resetAdvanceGuard drops both the block
  // and its banner). The cleanup cancels the timer whenever the banner goes
  // away first (track change, successful play, another error) or on unmount,
  // so a stale timer can never unblock/reset a newer storm.
  const errorInfo = usePlayerStore((state) => state.errorInfo);
  useEffect(() => {
    if (errorInfo?.code !== "advance_stopped") return;
    const timer = setTimeout(() => {
      if (usePlayerStore.getState().errorInfo?.code === "advance_stopped") {
        resetAdvanceGuard();
      }
    }, STORM_COOLDOWN_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [errorInfo]);
}
