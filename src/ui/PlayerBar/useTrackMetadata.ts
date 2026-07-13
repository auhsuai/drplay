import { useState, useEffect, useRef } from 'react';
import { Track } from '../../App';
import { getTrackMetadata } from '../../utils/metadata';
import { recordPlay } from '../../utils/history';
import { isFavorite, addFavorite, removeFavorite } from '../../utils/favorites';
import { listen } from '@tauri-apps/api/event';
import { getValidToken } from '../../utils/apiClient';
import { formatTime } from '../../utils/formatTime';
import { PlayerAction } from './types';

const TRACK_META_MODULE = 'useTrackMetadata';

// Classify an error for observability (no secrets logged). Mirrors the
// classify* helpers in apiClient.ts — only name/message are inspected.
function classifyTrackMetaError(err: unknown): string {
  if (err instanceof Error) return err.name || 'Error';
  if (typeof err === 'string') return err;
  return 'unknown';
}

const isTrustedStreamUrl = (url: string): boolean => {
  try {
    const u = new URL(url);
    return u.hostname === 'drplay.localhost' && u.pathname === '/stream';
  } catch { return false; }
};

export interface TrackMetadataAPI {
  coverUrl: string | null;
  realTitle: string;
  realArtist: string;
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

  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [realTitle, setRealTitle] = useState('');
  const [realArtist, setRealArtist] = useState('');
  const [isLiked, setIsLiked] = useState(false);
  const tauriBufferEndRef = useRef<number | null>(null);

  // Sync like status when track changes
  useEffect(() => {
    if (currentTrack) {
      // fallback: assume not-liked on error
      isFavorite(currentTrack.id).then(setIsLiked).catch(() => setIsLiked(false));
    }
  }, [currentTrack?.id]);

  // Listen to global favorite updates
  useEffect(() => {
    const handleFavoritesUpdated = () => {
      if (currentTrack) {
        // fallback: assume not-liked on error
      isFavorite(currentTrack.id).then(setIsLiked).catch(() => setIsLiked(false));
      }
    };
    handleFavoritesUpdated();
    window.addEventListener('favorites-updated', handleFavoritesUpdated);
    window.addEventListener('user-changed', handleFavoritesUpdated);
    return () => {
      window.removeEventListener('favorites-updated', handleFavoritesUpdated);
      window.removeEventListener('user-changed', handleFavoritesUpdated);
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

  // Track change effect — clears state, restores session, fetches metadata
  useEffect(() => {
    if (currentTrack) {
      setRealTitle(currentTrack.title);
      setRealArtist(currentTrack.artist || '');
      setCoverUrl(null);
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
      if (bufferFillRef.current) bufferFillRef.current.style.width = '0%';
    }
  }, [currentTrack?.id]);

  // Metadata fetch + play record
  useEffect(() => {
    if (currentTrack) {
      let isCancelled = false;
      let objectUrl: string | null = null;

      getValidToken().then(token => {
        if (isCancelled) return null;
        return getTrackMetadata(currentTrack.id, token || undefined, currentTrack.size, currentTrack.originalName);
      }).then(metadata => {
        if (!metadata || isCancelled) return;
        if (metadata.title) setRealTitle(metadata.title);
        if (metadata.artist) setRealArtist(metadata.artist);

        if (metadata.coverUrl) {
          setCoverUrl(metadata.coverUrl);
        } else if (metadata.pictureData && metadata.pictureFormat) {
          const blob = new Blob([new Uint8Array(metadata.pictureData)], { type: metadata.pictureFormat });
          objectUrl = URL.createObjectURL(blob);
          setCoverUrl(objectUrl);
        }
      })
        .catch(err => {
          if (!isCancelled) dispatch({ type: 'ERROR', error: { type: 'metadata', text: err.message } });
        });

      if (currentTrack.streamUrl && isTrustedStreamUrl(currentTrack.streamUrl)) {
        recordPlay(currentTrack).catch(e => console.error(`[${TRACK_META_MODULE}] record-play-failed`, e));
      }

      return () => {
        isCancelled = true;
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      };
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
        if (event.payload.total_size_byte > 0) {
          tauriBufferEndRef.current = (event.payload.buffer_end_byte / event.payload.total_size_byte) * 100;

          if (bufferFillRef.current) {
            bufferFillRef.current.style.left = '0%';
            bufferFillRef.current.style.width = `${tauriBufferEndRef.current}%`;
          }
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
    coverUrl,
    realTitle,
    realArtist,
    isLiked,
    toggleFavorite,
    tauriBufferEndRef,
  };
}
