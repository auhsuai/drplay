import React from 'react';
import { Track } from '../../../App';
import { captureError } from '../../../utils/errorLog';
import { invoke } from '@tauri-apps/api/core';
import { PlayerAction } from '../types';

interface UseAudioErrorRecoveryParams {
  currentTrack: Track | null;
  errorInfoRef: React.MutableRefObject<{ type: string; text: string } | null>;
  onNextTrackRefForEnded: React.MutableRefObject<(isAutoSkip?: boolean) => void>;
  dispatch: React.Dispatch<PlayerAction>;
  retryCountRef: React.MutableRefObject<number>;
}

export function useAudioErrorRecovery(params: UseAudioErrorRecoveryParams): {
  retryPlayback: () => Promise<void>;
} {
  const { currentTrack, errorInfoRef, onNextTrackRefForEnded, dispatch, retryCountRef } = params;

  const retryPlayback = React.useCallback(async () => {
    if (!currentTrack?.id) return;

    try {
      const ext = currentTrack.originalName?.split('.').pop()?.toLowerCase();
      await invoke('native_play', { fileId: currentTrack.id, position: 0, ext: ext ?? null });
      retryCountRef.current = 0;
      dispatch({ type: 'CLEAR_ERROR' });
    } catch (err) {
      retryCountRef.current += 1;
      captureError({ level: 'error', source: 'audio-engine', message: `retryPlayback failed (attempt ${retryCountRef.current})`, kind: 'retry' });

      if (retryCountRef.current < 3) {
        dispatch({ type: 'ERROR', error: { type: 'network_interrupted', text: 'Mạng không ổn định hoặc mất kết nối, vui lòng kiểm tra lại' } });
      } else {
        dispatch({ type: 'ERROR', error: { type: 'format_error', text: 'File lỗi định dạng, đang chuyển bài kế tiếp...' } });
        onNextTrackRefForEnded.current(true);
      }
    }
  }, [currentTrack, errorInfoRef, onNextTrackRefForEnded, dispatch, retryCountRef]);

  return { retryPlayback };
}
