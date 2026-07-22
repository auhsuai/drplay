import React from 'react';
import { Track } from '../../../App';
import { captureError } from '../../../utils/errorLog';
import { getValidToken } from '../../../utils/apiClient';
import { getTokenIssuedAt } from '../../../utils/tokenStore';
import { invoke } from '@tauri-apps/api/core';
import { PlayerAction } from '../types';
import { decideDecodeFailure, isProxyStreamUrl } from '../streamError';
import { classifyAudioError, captureRetryFailure } from '../utils/audioUtils';
import { HEAD_PROBE_TIMEOUT_MS, HEAD_PROBE_MAX_ATTEMPTS, HEAD_PROBE_BACKOFF_BASE_MS, RATE_LIMIT_COOLDOWN_MS, TOKEN_RECENCY_WINDOW_MS, RATE_LIMIT_RETRY_MIN_MS, RATE_LIMIT_RETRY_MAX_MS } from '../utils/audioConstants';
import type { TFunction } from 'i18next';

interface UseAudioErrorRecoveryParams {
  currentTrack: Track | null;
  currentTrackRef: React.MutableRefObject<Track | null>;
  errorInfoRef: React.MutableRefObject<{ type: string; text: string } | null>;
  onNextTrackRefForEnded: React.MutableRefObject<(isAutoSkip?: boolean) => void>;
  dispatch: React.Dispatch<PlayerAction>;
  t: TFunction;
  clearRetryTimeout: () => void;
  retryTimeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  rateLimitUntilRef: React.MutableRefObject<number>;
  lastKnownPositionRef: React.MutableRefObject<number>;
  errorPositionRef: React.MutableRefObject<number | null>;
  retryCountRef: React.MutableRefObject<number>;
  getActiveAudio: () => HTMLAudioElement | null;
  performRetry: (track: Track) => Promise<void>;
}

export function useAudioErrorRecovery(params: UseAudioErrorRecoveryParams): {
  handleAudioError: () => Promise<void>;
} {
  const { currentTrack, currentTrackRef, errorInfoRef, onNextTrackRefForEnded, dispatch, t,
    clearRetryTimeout, retryTimeoutRef, rateLimitUntilRef, lastKnownPositionRef,
    errorPositionRef, retryCountRef, getActiveAudio, performRetry } = params;

  const handleAudioError = React.useCallback(async () => {
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
      const track = currentTrackRef.current;
      if (track && isProxyStreamUrl(track?.streamUrl) && retryCountRef.current < 3) {
        try {
          const freshUrl = await invoke<string>('get_stream_url', { fileId: track.id });
          currentTrackRef.current = { ...track, streamUrl: freshUrl };
          performRetry(currentTrackRef.current).catch(e => captureRetryFailure('network-url-refresh', e));
          return;
        } catch (e) {
          captureError({ level: 'warn', source: 'audio-engine', message: `get_stream_url refresh after MEDIA_ERR_NETWORK failed (${classifyAudioError(e)})`, kind: 'network' });
        }
      }
      if (errorInfoRef.current?.type !== 'network_interrupted') {
        dispatch({ type: 'ERROR', error: { type: 'network_interrupted', text: t('player.network_interrupted', 'Mạng không ổn định hoặc mất kết nối, vui lòng kiểm tra lại') } });
      }
      return;
    }

    // HEAD probe
    let headOk = false;
    let errorType = 'transient';
    if (currentTrack?.streamUrl) {
      try {
        if (isProxyStreamUrl(currentTrack.streamUrl)) {
          let lastErrorType: string | null = null;
          for (let probe = 0; probe < HEAD_PROBE_MAX_ATTEMPTS && !headOk; probe++) {
            if (probe > 0) await new Promise(r => setTimeout(r, HEAD_PROBE_BACKOFF_BASE_MS * probe));
            try {
              const headResp = await fetch(currentTrack.streamUrl, { method: 'HEAD', signal: AbortSignal.timeout(HEAD_PROBE_TIMEOUT_MS) });
              if (headResp.ok) { headOk = true; }
              else {
                lastErrorType = headResp.headers.get('X-Stream-Error-Type') || 'transient';
                if (lastErrorType === 'rate-limited') rateLimitUntilRef.current = Date.now() + RATE_LIMIT_COOLDOWN_MS;
              }
            } catch { lastErrorType = 'transient'; }
          }
          if (!headOk && lastErrorType && lastErrorType !== 'transient') errorType = lastErrorType;
        }
      } catch (err) {
        captureError({ level: 'warn', source: 'audio-engine', message: `HEAD probe exception (${classifyAudioError(err)})`, kind: 'transient' });
        errorType = 'transient';
      }
    }

    if (errorType === 'permanent') {
      dispatch({ type: 'ERROR', error: { type: 'file_deleted', text: t('player.file_deleted', 'File không còn tồn tại trên Drive, đang chuyển bài...') } });
      onNextTrackRefForEnded.current(true);
      return;
    }
    if (errorType === 'access-denied') {
      dispatch({ type: 'ERROR', error: { type: 'access_denied', text: t('player.access_denied', 'Bạn không còn quyền truy cập file này, đang chuyển bài...') } });
      onNextTrackRefForEnded.current(true);
      return;
    }
    if (errorType === 'download-quota') {
      dispatch({ type: 'ERROR', error: { type: 'download_quota', text: t('player.download_quota', 'File đã vượt giới hạn tải xuống của Google, đang chuyển bài...') } });
      onNextTrackRefForEnded.current(true);
      return;
    }
    if (errorType === 'rate-limited') {
      dispatch({ type: 'ERROR', error: { type: 'rate_limited', text: t('player.rate_limited', 'Google Drive tạm thời quá tải, đang thử lại...') } });
      const waitMs = Math.max(RATE_LIMIT_RETRY_MIN_MS, Math.min(rateLimitUntilRef.current - Date.now(), RATE_LIMIT_RETRY_MAX_MS));
      clearRetryTimeout();
      retryTimeoutRef.current = setTimeout(() => { const t2 = currentTrackRef.current; if (t2?.streamUrl) performRetry(t2).catch(e => captureRetryFailure('rate-limited', e)); }, waitMs);
      return;
    }
    if (errorType === 'url-expired') {
      const track = currentTrackRef.current;
      if (track) {
        try {
          const freshUrl = await invoke<string>('get_stream_url', { fileId: track.id });
          currentTrackRef.current = { ...track, streamUrl: freshUrl };
          performRetry(currentTrackRef.current).catch(e => captureRetryFailure('url-expired', e));
          return;
        } catch (e) {
          captureError({ level: 'warn', source: 'audio-engine', message: `get_stream_url regenerate after url-expired failed (${classifyAudioError(e)})`, kind: 'url-expired' });
        }
      }
      dispatch({ type: 'ERROR', error: { type: 'network_interrupted', text: t('player.network_interrupted', 'Mạng không ổn định hoặc mất kết nối, vui lòng kiểm tra lại') } });
      return;
    }
    if (errorType === 'auth-expired') {
      try { await getValidToken(true); } catch (e) {
        captureError({ level: 'warn', source: 'audio-engine', message: `token refresh after auth-expired failed (${classifyAudioError(e)})`, kind: 'auth' });
      }
      const track = currentTrackRef.current;
      if (track?.streamUrl) performRetry(track).catch(e => captureRetryFailure('auth-expired', e));
      return;
    }

    const decision = decideDecodeFailure({ mediaErrorCode: error.code, headOk, ext: currentTrackRef.current?.originalName?.split('.').pop()?.toLowerCase() });
    if (decision.shouldRetryWithCorrectType) {
      const track = currentTrackRef.current;
      if (track?.streamUrl) performRetry(track).catch(e => captureRetryFailure('correct-type-retry', e));
      return;
    }
    if (decision.isDefinitiveFormatError) {
      const tokenTime = getTokenIssuedAt();
      if (tokenTime > 0 && Date.now() - tokenTime < TOKEN_RECENCY_WINDOW_MS) {
        const track = currentTrackRef.current;
        if (track?.streamUrl) { performRetry(track).catch(e => captureRetryFailure('format-error-retry', e)); return; }
      }
      dispatch({ type: 'ERROR', error: { type: 'format_error', text: t('player.format_error', 'Không thể phát file này, đang thử lại...') } });
      return;
    }
    if (errorInfoRef.current?.type !== 'network_interrupted') {
      dispatch({ type: 'ERROR', error: { type: 'network_interrupted', text: t('player.network_interrupted', 'Mạng không ổn định hoặc mất kết nối, vui lòng kiểm tra lại') } });
    }
  }, [currentTrack, currentTrackRef, errorInfoRef, onNextTrackRefForEnded, dispatch, t,
    clearRetryTimeout, retryTimeoutRef, rateLimitUntilRef, lastKnownPositionRef,
    errorPositionRef, retryCountRef, getActiveAudio, performRetry]);

  return { handleAudioError };
}
