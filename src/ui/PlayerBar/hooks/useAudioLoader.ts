import React from 'react';
import { Track } from '../../../App';
import { safePlay, safePause } from '../../../utils/safeAudio';
import { captureError } from '../../../utils/errorLog';
import { PlayerAction } from '../types';
import { classifyAudioError } from '../utils/audioUtils';
import { LOAD_METADATA_TIMEOUT_MS, CANPLAY_TIMEOUT_MS, SUPPRESS_ENDED_SAFETY_MS } from '../utils/audioConstants';
import { waitForAudioEvent } from '../utils/audioEventUtils';
import type { TFunction } from 'i18next';

export interface AudioLoaderAPI {
  loadNormalAudio: (track: Track, position: number | null, cancellationCheck?: () => boolean) => Promise<HTMLAudioElement>;
  performRetry: (track: Track) => Promise<void>;
  cleanupResumeHandlers: () => void;
  suppressEndedRef: React.MutableRefObject<boolean>;
}

interface UseAudioLoaderParams {
  audioRef: React.RefObject<HTMLAudioElement | null>;
  isPlayingRef: React.MutableRefObject<boolean>;
  errorPositionRef: React.MutableRefObject<number | null>;
  retryCountRef: React.MutableRefObject<number>;
  currentTrackRef: React.MutableRefObject<Track | null>;
  onNextTrackRefForEnded: React.MutableRefObject<(isAutoSkip?: boolean) => void>;
  dispatch: React.Dispatch<PlayerAction>;
  t: TFunction;
  clearRetryTimeout: () => void;
  lockSystemPauseRef: React.MutableRefObject<() => void>;
}

export function useAudioLoader(params: UseAudioLoaderParams): AudioLoaderAPI {
  const { audioRef, isPlayingRef, errorPositionRef, retryCountRef,
    onNextTrackRefForEnded, dispatch, t, clearRetryTimeout, lockSystemPauseRef } = params;

  const resumeHandlerRef = React.useRef<{ audio: HTMLAudioElement; handler: () => void } | null>(null);
  const resumeSeekRef = React.useRef<{ audio: HTMLAudioElement; handler: () => void } | null>(null);
  const isProgrammaticActionRef = React.useRef(false);

  // Suppress-ended flag management
  const suppressEndedRef = React.useRef(false);
  const suppressEndedSafetyRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const armSuppressEnded = () => {
    suppressEndedRef.current = true;
    if (suppressEndedSafetyRef.current) clearTimeout(suppressEndedSafetyRef.current);
    suppressEndedSafetyRef.current = setTimeout(() => {
      suppressEndedRef.current = false;
      suppressEndedSafetyRef.current = null;
    }, SUPPRESS_ENDED_SAFETY_MS);
  };

  const disarmSuppressEnded = () => {
    suppressEndedRef.current = false;
    if (suppressEndedSafetyRef.current) {
      clearTimeout(suppressEndedSafetyRef.current);
      suppressEndedSafetyRef.current = null;
    }
  };

  const cleanupResumeHandlers = () => {
    if (resumeHandlerRef.current) {
      resumeHandlerRef.current.audio.removeEventListener('loadedmetadata', resumeHandlerRef.current.handler);
      resumeHandlerRef.current = null;
    }
    if (resumeSeekRef.current) {
      resumeSeekRef.current.audio.removeEventListener('loadedmetadata', resumeSeekRef.current.handler);
      resumeSeekRef.current = null;
    }
  };

  async function loadNormalAudio(track: Track, position: number | null, cancellationCheck?: () => boolean): Promise<HTMLAudioElement> {
    const audio = audioRef.current;
    if (!audio || !track.streamUrl) throw new Error('No audio or stream URL');

    cleanupResumeHandlers();
    isProgrammaticActionRef.current = true;
    armSuppressEnded();
    lockSystemPauseRef.current();

    try {
      safePause(audio);
      audio.removeAttribute('src');
      audio.src = track.streamUrl;
      audio.load();

      if (cancellationCheck?.()) throw new Error('Cancelled');

      if (position !== null) {
        if (audio.readyState < HTMLMediaElement.HAVE_METADATA) {
          await waitForAudioEvent(audio, 'loadedmetadata', LOAD_METADATA_TIMEOUT_MS);
        }
        if (cancellationCheck?.()) throw new Error('Cancelled');
        audio.currentTime = position;
      }

      if (audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
        await waitForAudioEvent(audio, 'canplay', CANPLAY_TIMEOUT_MS);
      }

      if (cancellationCheck?.()) throw new Error('Cancelled');

      if (isPlayingRef.current) {
        await safePlay(audio);
      }

      disarmSuppressEnded();
      return audio;
    } finally {
      isProgrammaticActionRef.current = false;
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
      captureError({ level: 'error', source: 'audio-engine', message: `performRetry failed (attempt ${retryCountRef.current}, ${classifyAudioError(err)})`, kind: 'retry' });
      if (retryCountRef.current < 3) {
        dispatch({ type: 'ERROR', error: { type: 'network_interrupted', text: t('player.network_interrupted', 'Mạng không ổn định hoặc mất kết nối, vui lòng kiểm tra lại') } });
      } else {
        dispatch({ type: 'ERROR', error: { type: 'format_error', text: t('player.format_error', 'File lỗi định dạng, đang chuyển bài kế tiếp...') } });
        onNextTrackRefForEnded.current(true);
      }
    }
  }

  return { loadNormalAudio, performRetry, cleanupResumeHandlers, suppressEndedRef };
}
