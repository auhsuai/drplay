import { useEffect, useRef, useCallback } from 'react';
import { Track } from '../../App';
import { safePlay, safePause } from '../../utils/safeAudio';
import { updateTrackDuration } from '../../utils/metadata';
import { captureError } from '../../utils/errorLog';
import { getValidToken } from '../../utils/apiClient';
import { invoke } from '@tauri-apps/api/core';
import { set as idbSet } from 'idb-keyval';
import { PlayerAction, AudioRefs } from './types';
import type { TFunction } from 'i18next';

const AUDIO_MODULE = 'useAudioEngine';
const AUDIO_LOG = '[Player]';

// Threshold (seconds) within which an `ended` event is treated as "truly at the
// end of the track". An `ended` firing while currentTime is far from duration is
// a spurious/early-ended event (e.g. caused by a mid-track src reload) and must
// NOT trigger a track skip.
const ENDED_THRESHOLD_SEC = 1.0;

// Safety window (ms) after a programmatic reload during which any stray `ended`
// event is suppressed. Guarantees the suppress flag cannot stay stuck forever
// even if `canplay` never fires.
const SUPPRESS_ENDED_SAFETY_MS = 15000;

// Classify an audio-engine error for observability. Only surface the
// message/name — never log tokens, URLs, or signed stream credentials.
function classifyAudioError(err: unknown): string {
  if (err instanceof Error) {
    return err.message || err.name || 'Unknown audio error';
  }
  if (typeof err === 'string') return err;
  return 'Unknown audio error';
}

export interface AudioEngineAPI {
  audioRefs: AudioRefs;
  getActiveAudio: () => HTMLAudioElement | null;
  loadNormalAudio: (track: Track, position: number | null, cancellationCheck?: () => boolean) => Promise<HTMLAudioElement>;
  performRetry: (track: Track) => Promise<void>;
  handleEnded: (event?: React.SyntheticEvent<HTMLAudioElement>) => void;
  handleAudioError: () => Promise<void>;
  handleTimeUpdate: () => void;
  handleLoadedMetadata: () => void;
  handleCanPlay: () => void;
  handleWaiting: () => void;
  handlePlaying: () => void;
  lastKnownPositionRef: React.MutableRefObject<number>;
  errorPositionRef: React.MutableRefObject<number | null>;
  pendingBufferRestoreTimeRef: React.MutableRefObject<number | null>;
  restoredAudioTrackIdRef: React.MutableRefObject<string | null>;
  retryCountRef: React.MutableRefObject<number>;
  retryTimeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
}

interface UseAudioEngineParams {
  currentTrack: Track | null;
  isPlaying: boolean;
  playMode: 'normal' | 'shuffle' | 'repeat-all' | 'repeat-one';
  loadNonce: number | undefined;
  dispatch: React.Dispatch<PlayerAction>;
  t: TFunction;
  isPlayingRef: React.MutableRefObject<boolean>;
  errorInfoRef: React.MutableRefObject<{ type: string; text: string } | null>;
  onNextTrackRefForEnded: React.MutableRefObject<(isAutoSkip?: boolean) => void>;
  manualResume: boolean;
  rateLimitUntilRef: React.MutableRefObject<number>;
  setDuration: React.Dispatch<React.SetStateAction<number>>;
  setIsBuffering: React.Dispatch<React.SetStateAction<boolean>>;
}

export function useAudioEngine(params: UseAudioEngineParams): AudioEngineAPI {
  const { currentTrack, isPlaying, playMode, loadNonce, dispatch, t, isPlayingRef, errorInfoRef, onNextTrackRefForEnded, manualResume, rateLimitUntilRef, setDuration, setIsBuffering } = params;

  const audioRef = useRef<HTMLAudioElement>(null);
  const audioRef2 = useRef<HTMLAudioElement>(null);
  const activeAudioIndexRef = useRef<0 | 1>(0);

  const resumeHandlerRef = useRef<{ audio: HTMLAudioElement; handler: () => void } | null>(null);
  const resumeSeekRef = useRef<{ audio: HTMLAudioElement; handler: () => void } | null>(null);
  const isProgrammaticActionRef = useRef(false);
  const retryCountRef = useRef(0);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // When true, stray `ended` events (caused by a programmatic reload/refresh of
  // the active audio element's src) are suppressed so they do not trigger a
  // spurious track skip. Reset safely via try/finally + a safety timeout.
  const suppressEndedRef = useRef(false);
  const suppressEndedSafetyRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastKnownPositionRef = useRef(0);
  const errorPositionRef = useRef<number | null>(null);
  const lastSaveTimeRef = useRef(0);
  const pendingBufferRestoreTimeRef = useRef<number | null>(null);
  const restoredAudioTrackIdRef = useRef<string | null>(null);
  const currentTrackRef = useRef(currentTrack);
  currentTrackRef.current = currentTrack;

  // --- Buffering indicator (mạng yếu) ---
  // Chống nhấp nháy: chỉ hiện spinner sau 500ms `waiting`; ẩn ngay khi có data.
  // Watchdog qua `timeupdate` bắt các stall mà `waiting` không phát (MDN/hls.js).
  const isBufferingRef = useRef(false);
  const bufferingDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stallWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyBuffering = (v: boolean) => {
    if (isBufferingRef.current === v) return;
    isBufferingRef.current = v;
    setIsBuffering(v);
  };
  const clearBufferingTimers = () => {
    if (bufferingDelayRef.current) { clearTimeout(bufferingDelayRef.current); bufferingDelayRef.current = null; }
    if (stallWatchdogRef.current) { clearTimeout(stallWatchdogRef.current); stallWatchdogRef.current = null; }
  };

  const audioRefs: AudioRefs = { audioRef, audioRef2, activeAudioIndexRef };

  const getActiveAudio = useCallback(() => {
    return activeAudioIndexRef.current === 0 ? audioRef.current : audioRef2.current;
  }, []);

  const clearRetryTimeout = () => {
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
  };

  // Arm the suppress-ended flag before a programmatic reload. Any `ended` event
  // fired while this is active is treated as spurious. A safety timeout ensures
  // the flag is always cleared even if `canplay` never arrives.
  const armSuppressEnded = () => {
    suppressEndedRef.current = true;
    if (suppressEndedSafetyRef.current) clearTimeout(suppressEndedSafetyRef.current);
    suppressEndedSafetyRef.current = setTimeout(() => {
      suppressEndedRef.current = false;
      suppressEndedSafetyRef.current = null;
    }, SUPPRESS_ENDED_SAFETY_MS);
  };

  // Disarm the suppress-ended flag (called once the reload has settled, e.g. on
  // `canplay`). Clears the safety timeout so it does not fire later.
  const disarmSuppressEnded = () => {
    suppressEndedRef.current = false;
    if (suppressEndedSafetyRef.current) {
      clearTimeout(suppressEndedSafetyRef.current);
      suppressEndedSafetyRef.current = null;
    }
  };

  function cleanupResumeHandlers() {
    if (resumeHandlerRef.current) {
      resumeHandlerRef.current.audio.removeEventListener('loadedmetadata', resumeHandlerRef.current.handler);
      resumeHandlerRef.current = null;
    }
    if (resumeSeekRef.current) {
      resumeSeekRef.current.audio.removeEventListener('loadedmetadata', resumeSeekRef.current.handler);
      resumeSeekRef.current = null;
    }
  }

  function waitForAudioEvent(audio: HTMLAudioElement, event: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const handler = () => {
        if (timer) clearTimeout(timer);
        audio.removeEventListener(event, handler);
        resolve();
      };
      const onAbort = () => {
        if (timer) clearTimeout(timer);
        audio.removeEventListener(event, handler);
        reject(signal?.reason || new DOMException('Aborted', 'AbortError'));
      };
      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      timer = setTimeout(() => {
        audio.removeEventListener(event, handler);
        reject(new Error(`Timeout waiting for ${event} after ${timeoutMs}ms`));
      }, timeoutMs);
      audio.addEventListener(event, handler);
    });
  }

  async function loadNormalAudio(track: Track, position: number | null, cancellationCheck?: () => boolean): Promise<HTMLAudioElement> {
    const audio = audioRef.current;
    if (!audio || !track.streamUrl) throw new Error('No audio or stream URL');

    cleanupResumeHandlers();
    isProgrammaticActionRef.current = true;
    armSuppressEnded();

    try {
      safePause(audio);
      audio.removeAttribute('src');
      audio.src = track.streamUrl;
      audio.load();

      if (cancellationCheck?.()) throw new Error('Cancelled');

      if (position !== null) {
        if (audio.readyState < HTMLMediaElement.HAVE_METADATA) {
          await waitForAudioEvent(audio, 'loadedmetadata', 10000);
        }
        if (cancellationCheck?.()) throw new Error('Cancelled');
        audio.currentTime = position;
      }

      if (audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
        await waitForAudioEvent(audio, 'canplay', 30000);
      }

      if (cancellationCheck?.()) throw new Error('Cancelled');

      if (isPlayingRef.current) {
        await safePlay(audio);
      }

      activeAudioIndexRef.current = 0;
      disarmSuppressEnded();
      return audio;
    } finally {
      isProgrammaticActionRef.current = false;
      // Safety net: never leave the flag stuck if an exception escaped above.
      disarmSuppressEnded();
    }
  }

  async function performRetry(track: Track): Promise<void> {
    clearRetryTimeout();
    const pos = errorPositionRef.current;
    errorPositionRef.current = null;
    dispatch({ type: 'CLEAR_ERROR' });
    try {
      await loadNormalAudio(track, pos);
      retryCountRef.current = 0;
    } catch (err) {
      retryCountRef.current += 1;
      console.error('[Player] Retry failed', err);
      if (retryCountRef.current < 3) {
        dispatch({ type: 'ERROR', error: { type: 'network_interrupted', text: t('player.network_interrupted', 'Mạng không ổn định hoặc mất kết nối, vui lòng kiểm tra lại') } });
      } else {
        dispatch({ type: 'ERROR', error: { type: 'format_error', text: t('player.format_error', 'File lỗi định dạng, đang chuyển bài kế tiếp...') } });
        onNextTrackRefForEnded.current(true);
      }
    }
  }

  const handleEnded = (event?: React.SyntheticEvent<HTMLAudioElement>) => {
    if (manualResume) return;
    // A programmatic reload (src refresh / retry) may emit a stray `ended`;
    // suppress it so it does not cause a spurious track skip.
    if (suppressEndedRef.current) {
      console.warn(`${AUDIO_LOG} suppressed stray ended event during reload`);
      return;
    }

    // Only the active audio element can legitimately reach the end of the track.
    const active = getActiveAudio();
    const target = event?.currentTarget ?? active;
    if (!active || target !== active) {
      // `ended` fired on a non-active element (e.g. an idle/secondary audio
      // element) — ignore, it does not represent the currently playing track.
      console.warn(`${AUDIO_LOG} ignored ended on non-active audio element`);
      return;
    }

    const duration = active.duration;
    const currentTime = active.currentTime;
    const isRealEnd =
      active.ended &&
      isFinite(duration) && duration > 0 &&
      isFinite(currentTime) &&
      currentTime >= duration - ENDED_THRESHOLD_SEC;

    if (!isRealEnd) {
      // Spurious early `ended` (mid-track). Do not skip. Log with context only
      // (never URL/token). Avoid noisy warn when the element simply isn't at end.
      console.warn(
        `${AUDIO_LOG} ignored spurious ended (not at track end)`,
        { currentTime, duration, threshold: ENDED_THRESHOLD_SEC }
      );
      return;
    }

    if (playMode === 'repeat-one') {
      active.currentTime = 0;
      safePlay(active).catch(e => console.error(`${AUDIO_LOG} replay-failed`, classifyAudioError(e)));
    } else {
      onNextTrackRefForEnded.current();
    }
  };

  const handleAudioError = async () => {
    const audio = getActiveAudio();
    const error = audio?.error;
    if (!audio || !error) return;
    if (error.code === MediaError.MEDIA_ERR_ABORTED) {
      captureError({ level: 'info', source: 'audio-engine', message: 'Audio load aborted (MEDIA_ERR_ABORTED)', kind: 'abort' });
      return;
    }

    captureError({ level: 'error', source: 'audio-engine', message: `Audio error: code=${error.code}${error.message ? ' msg=' + error.message : ''}${lastKnownPositionRef.current > 0 ? ' pos=' + lastKnownPositionRef.current.toFixed(1) : ''}`, kind: error.code === MediaError.MEDIA_ERR_NETWORK ? 'network' : 'decode' });

    if (lastKnownPositionRef.current > 0) {
      errorPositionRef.current = Math.max(0, lastKnownPositionRef.current - 0.5);
    }

    const isOffline = !navigator.onLine;

    if (isOffline) {
      if (errorInfoRef.current?.type !== 'network_disconnected') {
        dispatch({ type: 'ERROR', error: { type: 'network_disconnected', text: t('player.network_disconnected', 'Mạng không ổn định hoặc mất kết nối, vui lòng kiểm tra lại') } });
      }
      return;
    }

    if (error.code === MediaError.MEDIA_ERR_NETWORK) {
      // We're online here (offline handled above). A network-class error on our
      // own signed proxy stream is almost always the resolved proxy URL expiring
      // while paused (the app's HMAC exp window), not a real connectivity loss.
      // Mint a fresh signed URL (busts the cached redirect) and resume from the
      // last position instead of showing a misleading network banner.
      const track = currentTrackRef.current;
      let isProxyStream = false;
      try {
        const u = new URL(track?.streamUrl ?? '');
        isProxyStream = u.hostname === 'drplay.localhost' && u.pathname === '/stream';
      } catch { isProxyStream = false; }

      if (track && isProxyStream && retryCountRef.current < 3) {
        try {
          const freshUrl = await invoke<string>('get_stream_url', { fileId: track.id });
          const freshTrack = { ...track, streamUrl: freshUrl };
          currentTrackRef.current = freshTrack;
          performRetry(freshTrack).catch(() => {});
          return;
        } catch (e) {
          console.warn('[Player] Failed to refresh stream URL after network error', e);
        }
      }

      if (errorInfoRef.current?.type !== 'network_interrupted') {
        dispatch({ type: 'ERROR', error: { type: 'network_interrupted', text: t('player.network_interrupted', 'Mạng không ổn định hoặc mất kết nối, vui lòng kiểm tra lại') } });
      }
      return;
    }

    let isRealFormatError = false;
    let errorType = 'transient';

    if (currentTrack?.streamUrl) {
      try {
        const u = new URL(currentTrack.streamUrl);
        if (u.hostname === 'drplay.localhost' && u.pathname === '/stream') {
          // Retry the HEAD probe a few times. During a transient Drive error
          // the proxy is still retrying upstream, so a single failed probe would
          // produce a false-positive banner. Only treat it as a real error if
          // all probes fail.
          let headOk = false;
          let lastErrorType: string | null = null;
          for (let probe = 0; probe < 3 && !headOk; probe++) {
            if (probe > 0) {
              await new Promise(r => setTimeout(r, 500 * probe));
            }
            try {
              const headResp = await fetch(currentTrack.streamUrl, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
              if (headResp.ok) {
                headOk = true;
              } else {
                lastErrorType = headResp.headers.get('X-Stream-Error-Type') || 'transient';
                if (lastErrorType === 'rate-limited') {
                  rateLimitUntilRef.current = Date.now() + 300_000;
                }
              }
            } catch {
              lastErrorType = 'transient';
            }
          }
          if (headOk) {
            isRealFormatError = true;
          } else if (lastErrorType && lastErrorType !== 'transient') {
            errorType = lastErrorType;
          }
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          errorType = 'transient';
        } else if (err instanceof TypeError) {
          errorType = 'transient';
        } else {
          errorType = 'transient';
        }
      }
    }

    if (errorType === 'permanent') {
      dispatch({ type: 'ERROR', error: { type: 'file_deleted', text: t('player.file_deleted', 'File không còn tồn tại trên Drive, đang chuyển bài...') } });
      onNextTrackRefForEnded.current(true);
      return;
    }

    if (errorType === 'access-denied') {
      // Share revoked / permission removed. Retrying is futile — inform and skip.
      dispatch({ type: 'ERROR', error: { type: 'access_denied', text: t('player.access_denied', 'Bạn không còn quyền truy cập file này, đang chuyển bài...') } });
      onNextTrackRefForEnded.current(true);
      return;
    }

    if (errorType === 'download-quota') {
      // This file's Drive download quota is exhausted (resets in ~24h). No point
      // retrying now — inform and skip to the next track.
      dispatch({ type: 'ERROR', error: { type: 'download_quota', text: t('player.download_quota', 'File đã vượt giới hạn tải xuống của Google, đang chuyển bài...') } });
      onNextTrackRefForEnded.current(true);
      return;
    }

    if (errorType === 'rate-limited') {
      dispatch({ type: 'ERROR', error: { type: 'rate_limited', text: t('player.rate_limited', 'Google Drive tạm thời quá tải, đang thử lại...') } });
      const waitMs = Math.max(5000, Math.min(rateLimitUntilRef.current - Date.now(), 60000));
      clearRetryTimeout();
      retryTimeoutRef.current = setTimeout(() => {
        const track = currentTrackRef.current;
        if (track?.streamUrl) {
          performRetry(track).catch(() => {});
        }
      }, waitMs);
      return;
    }

    if (errorType === 'url-expired') {
      // The signed stream URL expired (e.g. paused past the exp window). Mint a
      // fresh signed URL and retry silently instead of showing a network banner.
      const track = currentTrackRef.current;
      if (track) {
        try {
          const freshUrl = await invoke<string>('get_stream_url', { fileId: track.id });
          const freshTrack = { ...track, streamUrl: freshUrl };
          currentTrackRef.current = freshTrack;
          performRetry(freshTrack).catch(() => {});
          return;
        } catch (e) {
          console.warn('[Player] Failed to regenerate expired stream URL', e);
        }
      }
      dispatch({ type: 'ERROR', error: { type: 'network_interrupted', text: t('player.network_interrupted', 'Mạng không ổn định hoặc mất kết nối, vui lòng kiểm tra lại') } });
      return;
    }

    if (errorType === 'auth-expired') {
      // Proxy-side token recovery timed out. Refresh the token then retry the
      // same track rather than showing a network banner or skipping.
      try {
        await getValidToken(true);
      } catch (e) {
        console.warn('[Player] Token refresh after auth-expired failed', e);
      }
      const track = currentTrackRef.current;
      if (track?.streamUrl) {
        performRetry(track).catch(() => {});
      }
      return;
    }

    if (isRealFormatError && (error.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED || error.code === MediaError.MEDIA_ERR_DECODE)) {
      // A very recent token refresh strongly implies this "unsupported source"
      // was actually a 401 from an expired token (the proxy recovered and the
      // HEAD probe now succeeds), not a genuine format problem. Retry instead of
      // skipping the track.
      const tokenTime = Number(localStorage.getItem('drplay_token_time'));
      if (Number.isFinite(tokenTime) && Date.now() - tokenTime < 15000) {
        const track = currentTrackRef.current;
        if (track?.streamUrl) {
          performRetry(track).catch(() => {});
          return;
        }
      }
      dispatch({ type: 'ERROR', error: { type: 'format_error', text: t('player.format_error', 'Không thể phát file này, đang thử lại...') } });
      return;
    }

    if (errorInfoRef.current?.type !== 'network_interrupted') {
      dispatch({ type: 'ERROR', error: { type: 'network_interrupted', text: t('player.network_interrupted', 'Mạng không ổn định hoặc mất kết nối, vui lòng kiểm tra lại') } });
    }
  };

  const handleWaiting = () => {
    // Không hiện spinner khi đang pause hoặc đang ở trạng thái lỗi (đã có banner).
    if (!isPlayingRef.current || errorInfoRef.current) return;
    if (bufferingDelayRef.current || isBufferingRef.current) return;
    bufferingDelayRef.current = setTimeout(() => {
      bufferingDelayRef.current = null;
      if (isPlayingRef.current && !errorInfoRef.current) applyBuffering(true);
    }, 500);
  };

  const handlePlaying = () => {
    clearBufferingTimers();
    applyBuffering(false);
  };

  const handleTimeUpdate = () => {
    const audio = getActiveAudio();
    if (!audio) return;
    const time = audio.currentTime;
    if (time > 0 && isFinite(time)) lastKnownPositionRef.current = time;

    // Data đang chảy → chắc chắn không buffering; huỷ debounce đang chờ.
    if (bufferingDelayRef.current) { clearTimeout(bufferingDelayRef.current); bufferingDelayRef.current = null; }
    if (isBufferingRef.current) applyBuffering(false);
    // Watchdog: nếu 2s không có timeupdate nào nữa khi vẫn đang phát → coi là stall.
    if (stallWatchdogRef.current) clearTimeout(stallWatchdogRef.current);
    if (isPlayingRef.current) {
      stallWatchdogRef.current = setTimeout(() => {
        const a = getActiveAudio();
        if (a && !a.paused && !a.ended && isPlayingRef.current && !errorInfoRef.current) {
          applyBuffering(true);
        }
      }, 2000);
    }

    const now = Date.now();
    if (now - lastSaveTimeRef.current > 2000 && currentTrack) {
      idbSet('drplay_last_session', {
        track: currentTrack,
        time,
        duration: audio.duration || 0
      }).catch(e => console.warn(`[${AUDIO_MODULE}] session-save-failed`, classifyAudioError(e)));
      lastSaveTimeRef.current = now;
    }
  };

  const handleLoadedMetadata = () => {
    const audio = getActiveAudio();
    if (audio) {
      const accurateDuration = audio.duration;
      setDuration(accurateDuration);
      if (currentTrack) {
        updateTrackDuration(currentTrack.id, accurateDuration);
      }
    }
  };

  const handleCanPlay = () => {
    const audio = getActiveAudio();
    retryCountRef.current = 0;
    clearRetryTimeout();
    clearBufferingTimers();
    applyBuffering(false);
    if (errorInfoRef.current) {
      dispatch({ type: 'CLEAR_ERROR' });
    }
    if (!audio) return;
    if (pendingBufferRestoreTimeRef.current !== null) {
      const t = pendingBufferRestoreTimeRef.current;
      pendingBufferRestoreTimeRef.current = null;
      if (isFinite(t)) {
        audio.currentTime = t;
      }
      return;
    }
    if (currentTrack && currentTrack.restoreTime !== undefined && restoredAudioTrackIdRef.current !== currentTrack.id) {
      const t = currentTrack.restoreTime;
      if (isFinite(t)) {
        audio.currentTime = t;
      }
      restoredAudioTrackIdRef.current = currentTrack.id;
    }
  };

  // Volume sync
  useEffect(() => {
    const refs = [audioRef.current, audioRef2.current];
    for (const el of refs) {
      if (el) el.volume = 0.5; // placeholder — real volume comes from PlayerBar
    }
  }, []);

  // Load audio on track change
  useEffect(() => {
    if (!currentTrack?.streamUrl) return;
    let cancelled = false;
    const position = currentTrack.restoreTime ?? null;
    loadNormalAudio(currentTrack, position, () => cancelled).then(() => {
      if (!cancelled) dispatch({ type: 'PLAY_SUCCESS' });
    }).catch(err => {
      if (err.message === 'Cancelled') return;
      console.warn('[Player] loadNormalAudio error', err);
      if (err.name === 'NotAllowedError') {
        dispatch({ type: 'BLOCKED', time: getActiveAudio()?.currentTime ?? 0 });
      }
    });
    return () => { cancelled = true; };
  }, [loadNonce]);

  // Resume handler cleanup
  useEffect(() => {
    return () => {
      if (resumeHandlerRef.current) {
        resumeHandlerRef.current.audio.removeEventListener('loadedmetadata', resumeHandlerRef.current.handler);
        resumeHandlerRef.current = null;
      }
      if (resumeSeekRef.current) {
        resumeSeekRef.current.audio.removeEventListener('loadedmetadata', resumeSeekRef.current.handler);
        resumeSeekRef.current = null;
      }
    };
  }, []);

  // Pause / track change: không còn phát → xoá spinner buffering và mọi timer.
  useEffect(() => {
    if (!isPlaying) {
      clearBufferingTimers();
      applyBuffering(false);
    }
  }, [isPlaying, currentTrack?.id]);

  // Unmount cleanup for buffering timers.
  useEffect(() => clearBufferingTimers, []);

  return {
    audioRefs,
    getActiveAudio,
    loadNormalAudio,
    performRetry,
    handleEnded,
    handleAudioError,
    handleTimeUpdate,
    handleLoadedMetadata,
    handleCanPlay,
    handleWaiting,
    handlePlaying,
    lastKnownPositionRef,
    errorPositionRef,
    pendingBufferRestoreTimeRef,
    restoredAudioTrackIdRef,
    retryCountRef,
    retryTimeoutRef,
  };
}
