import { useState, useEffect, useRef } from 'react';
import { Track } from '../../App';
import { recordPlay } from '../../utils/history';
import { isFavorite, addFavorite, removeFavorite } from '../../utils/favorites';
import { listen } from '@tauri-apps/api/event';
import { captureError } from '../../utils/errorLog';
import { formatTime } from '../../utils/formatTime';
import { PlayerAction } from './types';
import { isProxyStreamUrl } from './streamError';
import { renderBufferFromBytes } from '../../utils/bufferedRange';

const TRACK_META_MODULE = 'useTrackMetadata';

// Classify an error for observability (no secrets logged). Mirrors the
// classify* helpers in apiClient.ts — only name/message are inspected.
function classifyTrackMetaError(err: unknown): string {
  if (err instanceof Error) return err.name || 'Error';
  if (typeof err === 'string') return err;
  return 'unknown';
}

export interface TrackMetadataAPI {
  realTitle: string;
  isLiked: boolean;
  toggleFavorite: () => Promise<void>;
  tauriBufferEndRef: React.MutableRefObject<number | null>;
}

interface UseTrackMetadataParams {
  currentTrack: Track | null;
  dispatch: React.Dispatch<PlayerAction>;
  progressFillRef: React.RefObject<HTMLDivElement | null>;
  currentTimeTextRef: React.RefObject<HTMLSpanElement | null>;
  bufferFillRef: React.RefObject<HTMLDivElement | null>;
  setDuration: React.Dispatch<React.SetStateAction<number>>;
}

export function useTrackMetadata(params: UseTrackMetadataParams): TrackMetadataAPI {
  const { currentTrack, dispatch, progressFillRef, currentTimeTextRef, bufferFillRef, setDuration } = params;

  const [realTitle, setRealTitle] = useState('');
  const [isLiked, setIsLiked] = useState(false);
  const tauriBufferEndRef = useRef<number | null>(null);

  // Sync once on track/user/favorite changes. The previous pair of effects ran
  // the same Dexie query twice on every track change and allowed an older query
  // to overwrite the state for a newer track if it resolved later.
  useEffect(() => {
    let cancelled = false;
    const trackId = currentTrack?.id;

    const syncFavoriteState = () => {
      if (!trackId) {
        setIsLiked(false);
        return;
      }
      void isFavorite(trackId)
        .then((liked) => {
          if (!cancelled) setIsLiked(liked);
        })
        .catch(() => {
          if (!cancelled) setIsLiked(false);
        });
    };

    syncFavoriteState();
    window.addEventListener('favorites-updated', syncFavoriteState);
    window.addEventListener('user-changed', syncFavoriteState);
    return () => {
      cancelled = true;
      window.removeEventListener('favorites-updated', syncFavoriteState);
      window.removeEventListener('user-changed', syncFavoriteState);
    };
  }, [currentTrack?.id]);

  const toggleFavorite = async () => {
    if (!currentTrack) return;
    if (isLiked) {
      await removeFavorite(currentTrack.id);
      setIsLiked(false);
    } else {
      await addFavorite(currentTrack);
      setIsLiked(true);
    }
  };

  // Track change effect — clears state, restores session, sets title/artist.
  // Title/artist come straight from the Track object (Drive filename); there
  // is no tag database to enrich them further.
  useEffect(() => {
    if (currentTrack) {
      setRealTitle(currentTrack.title);
      dispatch({ type: 'CLEAR_ERROR' });

      const restoreTime = currentTrack.restoreTime;
      const restoreDuration = currentTrack.restoreDuration;

      if (restoreTime !== undefined && Number.isFinite(restoreTime)) {
        const dur = typeof restoreDuration === 'number' && Number.isFinite(restoreDuration) ? restoreDuration : 0;
        setDuration(dur);
        if (currentTimeTextRef.current) currentTimeTextRef.current.textContent = formatTime(restoreTime);
        if (progressFillRef.current) {
          const pct = dur > 0 ? (restoreTime / dur) * 100 : 0;
          progressFillRef.current.style.width = `${pct}%`;
        }
      } else {
        setDuration(0);
        if (currentTimeTextRef.current) currentTimeTextRef.current.textContent = '0:00';
        if (progressFillRef.current) progressFillRef.current.style.width = '0%';
      }
      if (bufferFillRef.current) bufferFillRef.current.innerHTML = '';
    }
  }, [currentTrack?.id]);

  // Play record
  useEffect(() => {
    if (currentTrack && currentTrack.streamUrl && isProxyStreamUrl(currentTrack.streamUrl)) {
      recordPlay(currentTrack).catch(e => captureError({ level: 'warn', source: 'track-metadata', message: `recordPlay failed (${classifyTrackMetaError(e)})`, kind: 'history' }));
    }
  }, [currentTrack?.id]);

  // Buffer status listener
  useEffect(() => {
    tauriBufferEndRef.current = null;
    let unlistenBufferFn: (() => void) | null = null;
    let bufferCancelled = false;
    listen<{
      track_id: string;
      buffer_start_byte: number;
      buffer_end_byte: number;
      total_size_byte: number;
    }>('buffer-status', (event) => {
      if (currentTrack && event.payload.track_id === currentTrack.id) {
        const { buffer_start_byte, buffer_end_byte, total_size_byte } = event.payload;
        if (total_size_byte > 0) {
          tauriBufferEndRef.current = (buffer_end_byte / total_size_byte) * 100;
          // The buffer bar is driven by the proxy's custom `buffer-status`
          // event, NOT by HTMLAudioElement.buffered — this app streams through
          // a chunked Rust proxy that never populates the browser's native
          // buffered TimeRanges. Using audio.buffered left the bar empty.
          renderBufferFromBytes(bufferFillRef.current, buffer_start_byte, buffer_end_byte, total_size_byte);
        }
      }
    }).then(fn => {
      if (bufferCancelled) { fn(); return; }
      unlistenBufferFn = fn;
    }).catch(err => console.warn(`[${TRACK_META_MODULE}] buffer-listener-register-failed`, classifyTrackMetaError(err)));

    return () => {
      bufferCancelled = true;
      unlistenBufferFn?.();
    };
  }, [currentTrack?.id]);

  return {
    realTitle,
    isLiked,
    toggleFavorite,
    tauriBufferEndRef,
  };
}
