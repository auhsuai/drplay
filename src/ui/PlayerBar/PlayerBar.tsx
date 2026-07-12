import React, { useRef, useState, useEffect, useCallback } from "react";
import { CrossfadeEngine } from "../../utils/crossfade";
import { createPortal } from "react-dom";
import { Play, Pause, SkipBack, SkipForward, Volume2, Volume1, Volume, VolumeX, Loader2, Music, Shuffle, Repeat, Repeat1, Heart, Maximize2, WifiOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Track } from "../../App";
import { getTrackMetadata, updateTrackDuration } from '../../utils/metadata';
import { recordPlay } from '../../utils/history';
import { isFavorite, addFavorite, removeFavorite } from '../../utils/favorites';
import { MoreMenu } from '../components/MoreMenu';
import { set as idbSet } from 'idb-keyval';

import { listen } from '@tauri-apps/api/event';
import { safePlay, safePause } from "../../utils/safeAudio";
import { formatTime } from "../../utils/formatTime";
import { getValidToken } from "../../utils/apiClient";

const isTrustedStreamUrl = (url: string): boolean => {
  try {
    const u = new URL(url);
    return u.hostname === 'drplay.localhost' && u.pathname === '/stream';
  } catch { return false; }
};

interface PlayerBarProps {
  currentTrack: Track | null;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onNextTrack: () => void;
  onPrevTrack: () => void;
  isDownloading?: boolean;
  loadNonce?: number;
  playMode: 'normal' | 'shuffle' | 'repeat-all' | 'repeat-one';
  onTogglePlayMode: () => void;
  onExpandNowPlaying: () => void;
  crossfadeEnabled: boolean;
  crossfadeDuration: number;
}

export function PlayerBar({ currentTrack, isPlaying, onTogglePlay, onNextTrack, onPrevTrack, isDownloading, loadNonce, playMode, onTogglePlayMode, onExpandNowPlaying, crossfadeEnabled, crossfadeDuration }: PlayerBarProps) {
  const { t } = useTranslation();
  const audioRef = useRef<HTMLAudioElement>(null);
  const audioRef2 = useRef<HTMLAudioElement>(null);
  const activeAudioIndexRef = useRef<0 | 1>(0);
  const crossfadeEngineRef = useRef<CrossfadeEngine | null>(null);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const progressFillRef = useRef<HTMLDivElement>(null);
  const bufferFillRef = useRef<HTMLDivElement>(null);
  const currentTimeTextRef = useRef<HTMLSpanElement>(null);
  const volumeBarRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const [duration, setDuration] = useState(0);
  const [_isDraggingUI, setIsDraggingUI] = useState(false);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isVolumeActive, setIsVolumeActive] = useState(false);
  const [playbackStatus, setPlaybackStatus] = useState<'playing' | 'error-needs-manual-resume' | 'normal'>('normal');
  const [pendingResumeTime, setPendingResumeTime] = useState<number | null>(null);
  const volumeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seekTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resumeHandlerRef = useRef<{ audio: HTMLAudioElement; handler: () => void } | null>(null);
  const triggerVolumeActive = () => {
    setIsVolumeActive(true);
    if (volumeTimeoutRef.current) clearTimeout(volumeTimeoutRef.current);
    volumeTimeoutRef.current = setTimeout(() => setIsVolumeActive(false), 300);
  };
  
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [realTitle, setRealTitle] = useState("");
  const [realArtist, setRealArtist] = useState("");
  const [errorText, setErrorText] = useState("");
  const [isLiked, setIsLiked] = useState(false);
  const getActiveAudio = useCallback(() => {
    return activeAudioIndexRef.current === 0 ? audioRef.current : audioRef2.current;
  }, []);

  // Init CrossfadeEngine
  useEffect(() => {
    const engine = new CrossfadeEngine();
    crossfadeEngineRef.current = engine;
    return () => {
      engine.destroy();
      crossfadeEngineRef.current = null;
    };
  }, []);

  const crossfadeEnabledRef = useRef(crossfadeEnabled);
  const crossfadeDurationRef = useRef(crossfadeDuration);
  useEffect(() => { crossfadeEnabledRef.current = crossfadeEnabled; }, [crossfadeEnabled]);
  useEffect(() => { crossfadeDurationRef.current = crossfadeDuration; }, [crossfadeDuration]);

  const isTransitioningRef = useRef(false);
  const isProgrammaticActionRef = useRef(false);

  const MAX_RETRY = 5;
  const retryCountRef = useRef(0);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearRetryTimeout = () => {
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
  };

  useEffect(() => {
    return () => clearRetryTimeout();
  }, [currentTrack?.id]);

  const handleNextClick = () => {
    if (isTransitioningRef.current) return;
    isTransitioningRef.current = true;
    onNextTrack();
    setTimeout(() => { isTransitioningRef.current = false; }, 200);
  };

  const handlePrevClick = () => {
    if (isTransitioningRef.current) return;
    isTransitioningRef.current = true;
    onPrevTrack();
    setTimeout(() => { isTransitioningRef.current = false; }, 200);
  };
  
  const lastSaveTimeRef = useRef(0);
  const restoredAudioTrackIdRef = useRef<string | null>(null);
  const pendingBufferRestoreTimeRef = useRef<number | null>(null);
  const lastValidBufferPercentRef = useRef(0);
  const lastSeekTargetRef = useRef<number | null>(null);
  const lastSeekTimestampRef = useRef(0);
  const isSeekCorrectionRef = useRef(false);
  const arrowSeekBaseRef = useRef<number | null>(null);
  const isArrowSeekingRef = useRef(false);
  const arrowTargetTimeRef = useRef(0);

  // Sync like status when track changes
  useEffect(() => {
    lastValidBufferPercentRef.current = 0;
    if (currentTrack) {
      isFavorite(currentTrack.id).then(setIsLiked).catch(() => setIsLiked(false));
    }
  }, [currentTrack?.id]);

  // Listen to global favorite updates
  useEffect(() => {
    const handleFavoritesUpdated = () => {
      if (currentTrack) {
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

  useEffect(() => {
    if (currentTrack) {
      setRealTitle(currentTrack.title);
      setRealArtist(currentTrack.artist || "");
      setCoverUrl(null);
      setErrorText("");
      
      if (currentTrack.restoreTime !== undefined) {
         setDuration(currentTrack.restoreDuration || 0);
         if (currentTimeTextRef.current) currentTimeTextRef.current.textContent = formatTime(currentTrack.restoreTime);
         if (progressFillRef.current) progressFillRef.current.style.width = `${(currentTrack.restoreTime / (currentTrack.restoreDuration || 1)) * 100}%`;
      } else {
         setDuration(0);
         if (currentTimeTextRef.current) currentTimeTextRef.current.textContent = '0:00';
         if (progressFillRef.current) progressFillRef.current.style.width = '0%';
      }
      if (bufferFillRef.current) bufferFillRef.current.style.width = '0%';
    }
  }, [currentTrack?.id]);

  const tauriBufferEndRef = useRef<number | null>(null);

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
    });

    return () => {
      bufferCancelled = true;
      unlistenBufferFn?.();
    };
  }, [currentTrack?.id]);

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
          if (!isCancelled) setErrorText(err.message);
        });
        
      if (currentTrack.streamUrl && isTrustedStreamUrl(currentTrack.streamUrl)) {
        recordPlay(currentTrack).catch(e => console.error("Failed to record play", e));
      }
      
      return () => {
        isCancelled = true;
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      };
    }
  }, [currentTrack?.id]);

  const onTogglePlayRef = useRef(onTogglePlay);
  const onNextTrackRef = useRef(onNextTrack);
  const onPrevTrackRef = useRef(onPrevTrack);
  const onTogglePlayModeRef = useRef(onTogglePlayMode);
  const onToggleNowPlayingRef = useRef(onExpandNowPlaying);
  const isPlayingRef = useRef(isPlaying);
  const playbackStatusRef = useRef(playbackStatus);
  const handleManualResumeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    playbackStatusRef.current = playbackStatus;
  }, [playbackStatus]);

  useEffect(() => {
    handleManualResumeRef.current = handleManualResume;
  }, [handleManualResume]);

  // Media Session API Integration
  useEffect(() => {
    if ('mediaSession' in navigator && currentTrack) {
      const artwork: MediaImage[] = [];
      if (currentTrack.coverUrl) {
        artwork.push({ src: currentTrack.coverUrl, sizes: '512x512', type: 'image/jpeg' });
      }

      navigator.mediaSession.metadata = new MediaMetadata({
        title: realTitle || currentTrack.title || currentTrack.originalName || 'Unknown Title',
        artist: realArtist || currentTrack.artist || 'DrPlay',
        artwork,
      });

      navigator.mediaSession.setActionHandler('play', () => onTogglePlayRef.current());
      navigator.mediaSession.setActionHandler('pause', () => onTogglePlayRef.current());
      navigator.mediaSession.setActionHandler('previoustrack', () => onPrevTrackRef.current());
      navigator.mediaSession.setActionHandler('nexttrack', () => onNextTrackRef.current());
    }

    return () => {
      if ('mediaSession' in navigator) {
        navigator.mediaSession.setActionHandler('play', null);
        navigator.mediaSession.setActionHandler('pause', null);
        navigator.mediaSession.setActionHandler('previoustrack', null);
        navigator.mediaSession.setActionHandler('nexttrack', null);
      }
    };
  }, [currentTrack, realTitle, realArtist]);

  // Stop audio on logout
  useEffect(() => {
    const handlePlayerStop = () => {
      for (const el of [audioRef.current, audioRef2.current]) {
        if (el) {
          safePause(el);
          el.removeAttribute('src');
          el.load();
        }
      }
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'paused';
        navigator.mediaSession.metadata = null;
      }
      activeAudioIndexRef.current = 0;
    };
    window.addEventListener('player-stop', handlePlayerStop);
    return () => window.removeEventListener('player-stop', handlePlayerStop);
  }, []);

  // Bluetooth / Device disconnect auto-pause
  useEffect(() => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    
    let lastDeviceCount = 0;
    const checkDevices = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioOutputs = devices.filter(d => d.kind === 'audiooutput');
        return audioOutputs.length;
      } catch (e) {
        return 0;
      }
    };

    checkDevices().then(count => { lastDeviceCount = count; }).catch(() => {});

    const handleDeviceChange = async () => {
      const newCount = await checkDevices();
      if (newCount < lastDeviceCount) {
        // A device was removed (e.g. Bluetooth disconnected)
        if (isPlayingRef.current) {
          onTogglePlayRef.current();
        }
      }
      lastDeviceCount = newCount;
    };

    navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange);
    return () => navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange);
  }, []);

  useEffect(() => {
    onTogglePlayRef.current = onTogglePlay;
    onNextTrackRef.current = handleNextClick;
    onPrevTrackRef.current = handlePrevClick;
    onTogglePlayModeRef.current = onTogglePlayMode;
    onToggleNowPlayingRef.current = onExpandNowPlaying;
  }, [onTogglePlay, onNextTrack, onPrevTrack, onTogglePlayMode, onExpandNowPlaying]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        document.activeElement?.tagName === 'INPUT' ||
        document.activeElement?.tagName === 'TEXTAREA' ||
        (document.activeElement as HTMLElement)?.isContentEditable
      ) {
        return;
      }

      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          const arrowLeftActive = getActiveAudio();
          if (arrowLeftActive) {
            const now = Date.now();
            if (arrowSeekBaseRef.current === null || now - lastSeekTimestampRef.current > 500) {
              arrowSeekBaseRef.current = arrowLeftActive.currentTime;
            }
            lastSeekTimestampRef.current = now;
            const newTime = Math.max(0, arrowSeekBaseRef.current - 5);
            arrowSeekBaseRef.current = newTime;
            arrowLeftActive.currentTime = newTime;
            lastSeekTargetRef.current = newTime;
            isArrowSeekingRef.current = false;
          }
          break;
        case 'ArrowRight':
          e.preventDefault();
          const arrowRightActive = getActiveAudio();
          if (arrowRightActive) {
            const now = Date.now();
            if (arrowSeekBaseRef.current === null || now - lastSeekTimestampRef.current > 500) {
              arrowSeekBaseRef.current = arrowRightActive.currentTime;
            }
            lastSeekTimestampRef.current = now;
            const dur = arrowRightActive.duration || 0;
            const newTime = Math.min(dur, arrowSeekBaseRef.current + 5);
            arrowSeekBaseRef.current = newTime;

            const isInBuffer = tauriBufferEndRef.current === null || dur <= 0 ||
              newTime <= (tauriBufferEndRef.current / 100) * dur;

            if (isInBuffer) {
              arrowRightActive.currentTime = newTime;
              lastSeekTargetRef.current = newTime;
              isArrowSeekingRef.current = false;
            } else {
              isArrowSeekingRef.current = true;
              arrowTargetTimeRef.current = newTime;
              if (currentTimeTextRef.current) {
                currentTimeTextRef.current.textContent = formatTime(newTime);
              }
              if (progressFillRef.current && dur > 0) {
                progressFillRef.current.style.width = `${(newTime / dur) * 100}%`;
              }
            }
          }
          break;
        case 'ArrowUp':
          e.preventDefault();
          triggerVolumeActive();
          setVolume(prev => Math.min(1, prev + 0.1));
          break;
        case 'ArrowDown':
          e.preventDefault();
          triggerVolumeActive();
          setVolume(prev => Math.max(0, prev - 0.1));
          break;
        case 'm':
        case 'M':
          e.preventDefault();
          setIsMuted(prev => !prev);
          break;
        case 'n':
        case 'N':
          e.preventDefault();
          onNextTrackRef.current();
          break;
        case 'p':
        case 'P':
          e.preventDefault();
          onPrevTrackRef.current();
          break;
        case 's':
        case 'S':
          e.preventDefault();
          onTogglePlayModeRef.current();
          break;
        case 'F11':
          e.preventDefault();
          if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(console.error);
          } else {
            if (document.exitFullscreen) {
              document.exitFullscreen().catch(console.error);
            }
          }
          break;
        case ' ':
          e.preventDefault();
          if (playbackStatusRef.current === 'error-needs-manual-resume') {
            handleManualResumeRef.current?.();
          } else {
            onTogglePlayRef.current();
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Keyup: kết thúc arrow seeking → seek audio element một lần duy nhất
  useEffect(() => {
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' && isArrowSeekingRef.current) {
        const active = getActiveAudio();
        if (active) {
          isArrowSeekingRef.current = false;
          const target = arrowTargetTimeRef.current;
          if (target > 0) {
            active.currentTime = target;
            lastSeekTargetRef.current = target;
          }
        }
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        arrowSeekBaseRef.current = null;
      }
    };

    window.addEventListener('keyup', handleKeyUp);
    return () => window.removeEventListener('keyup', handleKeyUp);
  }, []);

  useEffect(() => {
    return () => {
      if (resumeHandlerRef.current) {
        resumeHandlerRef.current.audio.removeEventListener('loadedmetadata', resumeHandlerRef.current.handler);
        resumeHandlerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    for (const el of [audioRef.current, audioRef2.current]) {
      if (el) el.volume = isMuted ? 0 : volume;
    }
  }, [volume, isMuted, currentTrack]);

  useEffect(() => {
    if (isPlaying) {
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
      const active = getActiveAudio();
      if (active) {
        const playPromise = safePlay(active);
        if (playPromise !== undefined) {
          playPromise.catch((e) => {
            if (e.name !== 'AbortError') {
              console.error("Playback failed", e);
            }
          });
        }
      }
    } else {
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
      const active = getActiveAudio();
      if (active) safePause(active);
    }
  }, [isPlaying]);



  const currentTrackRef = useRef(currentTrack);
  currentTrackRef.current = currentTrack;

  useEffect(() => {
    let rateLimitRetryTimeout: ReturnType<typeof setTimeout> | null = null;
    let tokenExpiredFn: (() => void) | null = null;
    let quotaExceededFn: (() => void) | null = null;
    let streamCancelled = false;
    listen('token-expired', async () => {
      console.warn('[Player] Token expired mid-stream, auto refreshing...');
      try {
        await getValidToken(true);
        const active = getActiveAudio();
        const track = currentTrackRef.current;
        if (active && track?.streamUrl && isTrustedStreamUrl(track.streamUrl)) {
          const resumeTime = active.currentTime;
          active.src = track.streamUrl;
          active.load();
          active.currentTime = resumeTime;
          await safePlay(active);
        }
      } catch (err) {
        console.error('[Player] Refresh token failed', err);
      }
    }).then(fn => {
      if (streamCancelled) { fn(); return; }
      tokenExpiredFn = fn;
    });

    listen('drive-quota-exceeded', () => {
      console.warn('[Player] Google Drive API quota exceeded');
      setErrorText('Google Drive đang quá tải, thử lại sau ít phút...');
      if (rateLimitRetryTimeout) clearTimeout(rateLimitRetryTimeout);
      rateLimitRetryTimeout = setTimeout(async () => {
        const active = getActiveAudio();
        const track = currentTrackRef.current;
        if (active && track?.streamUrl) {
          active.load();
          await safePlay(active).catch(() => {});
        }
      }, 30_000);
    }).then(fn => {
      if (streamCancelled) { fn(); return; }
      quotaExceededFn = fn;
    });

    return () => {
      streamCancelled = true;
      if (rateLimitRetryTimeout) clearTimeout(rateLimitRetryTimeout);
      tokenExpiredFn?.();
      quotaExceededFn?.();
    };
  }, []);

  const handleEnded = () => {
    if (playMode === 'repeat-one') {
      const active = getActiveAudio();
      if (active) {
        active.currentTime = 0;
        safePlay(active).catch(e => console.error("Replay failed", e));
      }
    } else {
      handleNextClick();
    }
  };

  const handleAudioError = async () => {
    const audio = getActiveAudio();
    const error = audio?.error;
    if (!audio || !error) return;

    const isOffline = !navigator.onLine;

    if (isOffline) {
      setErrorText(t('player.network_disconnected', 'Mạng không ổn định hoặc mất kết nối, vui lòng kiểm tra lại'));
      const RETREAT_OFFSET_SEC = 0.5;
      const positionBeforeError = Math.max(0, audio.currentTime - RETREAT_OFFSET_SEC);
      setPlaybackStatus('error-needs-manual-resume');
      setPendingResumeTime(positionBeforeError);
      return;
    }

    let isRealFormatError = false;
    let errorType = 'transient';

    try {
      if (currentTrack?.streamUrl && isTrustedStreamUrl(currentTrack.streamUrl)) {
        const headResp = await fetch(currentTrack.streamUrl, { method: 'HEAD' });
        if (headResp.ok) {
          isRealFormatError = true;
        } else {
          errorType = headResp.headers.get("X-Stream-Error-Type") || 'transient';
        }
      }
    } catch (e) {
      errorType = 'transient'; // Network error or proxy unreachable
    }

    if (errorType === 'permanent') {
      setErrorText('File không còn tồn tại trên Drive, đang chuyển bài...');
      handleNextClick();
      return;
    }

    if (isRealFormatError && (error.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED || error.code === MediaError.MEDIA_ERR_DECODE)) {
      setErrorText('File lỗi định dạng, đang chuyển bài kế tiếp...');
      handleNextClick();
      return;
    }

    setErrorText(t('player.network_interrupted', 'Mạng không ổn định hoặc mất kết nối, vui lòng kiểm tra lại'));
    const RETREAT_OFFSET_SEC = 0.5;
    const positionBeforeError = Math.max(0, audio.currentTime - RETREAT_OFFSET_SEC);

    if (retryCountRef.current >= MAX_RETRY) {
      setPlaybackStatus('error-needs-manual-resume');
      setPendingResumeTime(positionBeforeError);
      return;
    }

    const backoffMs = Math.min(1500 * Math.pow(2, retryCountRef.current), 15000);
    retryCountRef.current += 1;

    clearRetryTimeout();
    retryTimeoutRef.current = setTimeout(() => {
      const handleMetadataReady = async () => {
        audio.removeEventListener('loadedmetadata', handleMetadataReady);
        audio.currentTime = positionBeforeError;
        
        try {
          await safePlay(audio);
          setPlaybackStatus('playing');
        } catch (err: any) {
          if (err.name === 'NotAllowedError') {
            console.warn('[Player] Autoplay blocked, cần user gesture để resume');
            setPlaybackStatus('error-needs-manual-resume');
            setPendingResumeTime(positionBeforeError);
          }
        }
      };
      
      audio.addEventListener('loadedmetadata', handleMetadataReady);
      audio.load();
    }, backoffMs);
  };

  useEffect(() => {
    const audio = audioRef.current;
    const audio2 = audioRef2.current;
    if (!audio || !audio2 || !currentTrack?.streamUrl || !isTrustedStreamUrl(currentTrack.streamUrl)) return;

    let cancelled = false;

    const loadAndPlay = async () => {
      const hasActiveSrc = (activeAudioIndexRef.current === 0 ? audio.src : audio2.src) !== '';
      const shouldCrossfade = crossfadeEnabledRef.current && isPlaying && hasActiveSrc;

      if (shouldCrossfade) {
        const fromIndex = activeAudioIndexRef.current;
        const toIndex = (fromIndex === 0 ? 1 : 0) as 0 | 1;
        const fromEl = fromIndex === 0 ? audio : audio2;
        const toEl = toIndex === 0 ? audio : audio2;

        isProgrammaticActionRef.current = true;
        toEl.src = currentTrack.streamUrl;
        toEl.load();
        setTimeout(() => { isProgrammaticActionRef.current = false; }, 50);

        if (cancelled) return;

        await new Promise<void>(resolve => {
          const handler = () => {
            toEl.removeEventListener('canplay', handler);
            resolve();
          };
          toEl.addEventListener('canplay', handler);
        });

        if (cancelled) return;

        const engine = crossfadeEngineRef.current;
        if (engine) {
          await engine.ensureContext();
          engine.connect(fromEl, fromIndex);
          engine.connect(toEl, toIndex);
          engine.setGain(fromIndex, 1);
          engine.setGain(toIndex, 0);

          try {
            await safePlay(toEl);
          } catch (err: any) {
            if (err.name === 'NotAllowedError') {
              setPlaybackStatus('error-needs-manual-resume');
              return;
            }
          }

          if (cancelled) return;
          const fadeMs = crossfadeDurationRef.current;
          await engine.crossfade(fromIndex, toIndex, fadeMs);
          isProgrammaticActionRef.current = true;
          safePause(fromEl);
          fromEl.removeAttribute('src');
          fromEl.load();
          setTimeout(() => { isProgrammaticActionRef.current = false; }, 50);
          activeAudioIndexRef.current = toIndex;
          setPlaybackStatus('playing');
        }
      } else {
        // Normal mode — load into primary audio (index 0)
        isProgrammaticActionRef.current = true;
        safePause(audio);
        audio.src = currentTrack.streamUrl;
        audio.load();
        setTimeout(() => { isProgrammaticActionRef.current = false; }, 50);

        if (cancelled) return;

        if (currentTrack.restoreTime) {
          await new Promise<void>(resolve => {
            const handler = () => {
              audio.removeEventListener('loadedmetadata', handler);
              resolve();
            };
            audio.addEventListener('loadedmetadata', handler);
          });

          if (cancelled) return;
          audio.currentTime = currentTrack.restoreTime;
        }

        await new Promise<void>(resolve => {
          if (audio.readyState >= 3) {
            resolve();
            return;
          }
          const handler = () => {
            audio.removeEventListener('canplay', handler);
            resolve();
          };
          audio.addEventListener('canplay', handler);
        });

        if (cancelled) return;

        if (isPlayingRef.current) {
          try {
            await safePlay(audio);
            setPlaybackStatus('playing');
          } catch (err: any) {
            console.warn('[Player] play() interrupted', err);
            if (err.name === 'NotAllowedError') {
              setPlaybackStatus('error-needs-manual-resume');
              setPendingResumeTime(audio.currentTime);
            }
          }
        }

        if (crossfadeEngineRef.current) {
          crossfadeEngineRef.current.setGain(0, 1);
          crossfadeEngineRef.current.setGain(1, 1);
        }
        activeAudioIndexRef.current = 0;
      }
    };

    loadAndPlay();

    return () => {
      cancelled = true;
      if (audio) {
        audio.removeAttribute('src');
        audio.load();
      }
      if (audio2) {
        audio2.removeAttribute('src');
        audio2.load();
      }
    };
  }, [loadNonce]);

  async function handleManualResume() {
    const audio = getActiveAudio();
    if (!audio || pendingResumeTime === null) return;

    if (resumeHandlerRef.current) {
      resumeHandlerRef.current.audio.removeEventListener('loadedmetadata', resumeHandlerRef.current.handler);
    }

    audio.removeAttribute('src');
    audio.load();
    audio.src = (currentTrack?.streamUrl && isTrustedStreamUrl(currentTrack.streamUrl)) ? currentTrack.streamUrl : '';
    audio.load();

    const resumeHandler = () => {
      if (resumeHandlerRef.current?.audio === audio) {
        resumeHandlerRef.current = null;
      }
      audio.removeEventListener('loadedmetadata', resumeHandler);
      audio.currentTime = pendingResumeTime;
      safePlay(audio).then(() => {
        setPlaybackStatus('playing');
        setPendingResumeTime(null);
        retryCountRef.current = 0;
        setErrorText('');
      }).catch((err) => {
        console.error("Manual resume failed", err);
      });
    };
    
    audio.addEventListener('loadedmetadata', resumeHandler);
    resumeHandlerRef.current = { audio, handler: resumeHandler };
  }

  // Auto-recovery when network reconnects
  useEffect(() => {
    const handleOnline = async () => {
      if (playbackStatus === 'error-needs-manual-resume' && pendingResumeTime !== null) {
        if (
          errorText === t('player.network_disconnected', 'Mạng không ổn định hoặc mất kết nối, vui lòng kiểm tra lại') ||
          errorText === t('player.network_interrupted', 'Mạng không ổn định hoặc mất kết nối, vui lòng kiểm tra lại')
        ) {
          await handleManualResume();
        }
      }
    };
    
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [playbackStatus, pendingResumeTime, errorText, currentTrack]);

  // Sync Audio Focus (OS-level pause/play)
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleSystemPause = () => {
      if (isProgrammaticActionRef.current) return;
      if (isPlayingRef.current) {
        onTogglePlayRef.current(); 
      }
    };

    const handleSystemPlay = () => {
      if (isProgrammaticActionRef.current) return;
      if (!isPlayingRef.current) {
        onTogglePlayRef.current();
      }
    };

    audio.addEventListener('pause', handleSystemPause);
    audio.addEventListener('play', handleSystemPlay);

    return () => {
      audio.removeEventListener('pause', handleSystemPause);
      audio.removeEventListener('play', handleSystemPlay);
    };
  }, []);

  const handleTimeUpdate = () => {
    const audio = getActiveAudio();
    if (audio && !isDraggingRef.current) {
      const time = audio.currentTime;
      
      const now = Date.now();
      if (now - lastSaveTimeRef.current > 2000 && currentTrack) {
        idbSet('drplay_last_session', {
          track: currentTrack,
          time,
          duration: audio.duration || duration
        });
        lastSaveTimeRef.current = now;
      }
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
    if (audio) {
      if (pendingBufferRestoreTimeRef.current !== null) {
        audio.currentTime = pendingBufferRestoreTimeRef.current;
        pendingBufferRestoreTimeRef.current = null;
      }

      if (currentTrack && currentTrack.restoreTime !== undefined && restoredAudioTrackIdRef.current !== currentTrack.id) {
        audio.currentTime = currentTrack.restoreTime;
        restoredAudioTrackIdRef.current = currentTrack.id;
      }
    }
  };

  // Verify seek accuracy after browser finishes seeking
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleSeeked = () => {
      if (isSeekCorrectionRef.current) {
        isSeekCorrectionRef.current = false;
        return;
      }
      const active = getActiveAudio();
      if (lastSeekTargetRef.current !== null && active) {
        const diff = Math.abs(active.currentTime - lastSeekTargetRef.current);
        if (diff > 1) {
          isSeekCorrectionRef.current = true;
          active.currentTime = lastSeekTargetRef.current;
        }
        lastSeekTargetRef.current = null;
      }
    };

    audio.addEventListener('seeked', handleSeeked);
    return () => audio.removeEventListener('seeked', handleSeeked);
  }, []);

  // Removed bufferSeconds effect

  // Save session immediately on track change and on exit
  useEffect(() => {
    const saveSession = () => {
      if (!currentTrack) return;
      
      const active = getActiveAudio();
      let timeToSave = active?.currentTime || 0;
      let durationToSave = duration;
      
      if (active && currentTrack.streamUrl && active.readyState >= 1) {
         timeToSave = active.currentTime || timeToSave;
         durationToSave = active.duration || durationToSave;
      } else if (currentTrack.restoreTime !== undefined && restoredAudioTrackIdRef.current !== currentTrack.id) {
         timeToSave = currentTrack.restoreTime;
         durationToSave = currentTrack.restoreDuration || durationToSave;
      }

      idbSet('drplay_last_session', {
        track: currentTrack,
        time: timeToSave,
        duration: durationToSave
      });
      localStorage.removeItem('drplay_last_session');
    };
    
    // Save immediately
    saveSession();

    window.addEventListener('beforeunload', saveSession);
    return () => window.removeEventListener('beforeunload', saveSession);
  }, [currentTrack]);


  useEffect(() => {
    let lastTimeText = "";
    let lastProgressWidth = "";
    const activeAudio = getActiveAudio();
    
    const updateProgressUI = () => {
      const audio = getActiveAudio();
      if (audio && !isDraggingRef.current && !isArrowSeekingRef.current && progressFillRef.current && currentTimeTextRef.current) {
        // Prevent UI jump to 0:00 when waiting for track to restore
        if (currentTrack && currentTrack.restoreTime !== undefined && restoredAudioTrackIdRef.current !== currentTrack.id) {
          return;
        }

        const time = audio.currentTime;
        const dur = audio.duration || duration;
        if (dur > 0) {
          const progressPercent = (time / dur) * 100;
          const newWidth = `${progressPercent}%`;
          
          if (Math.abs(parseFloat(lastProgressWidth) - progressPercent) > 0.05 || lastProgressWidth === "") {
            progressFillRef.current.style.width = newWidth;
            lastProgressWidth = newWidth;
          }
          
          const newTimeText = formatTime(time);
          if (lastTimeText !== newTimeText) {
            currentTimeTextRef.current.textContent = newTimeText;
            lastTimeText = newTimeText;
          }
        }
      }
    };

    if (activeAudio) {
      activeAudio.addEventListener('timeupdate', updateProgressUI);
      activeAudio.addEventListener('progress', updateProgressUI);
      updateProgressUI();
      
      return () => {
        activeAudio.removeEventListener('timeupdate', updateProgressUI);
        activeAudio.removeEventListener('progress', updateProgressUI);
      };
    }
  }, [duration, currentTrack]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!getActiveAudio() || duration === 0 || !progressBarRef.current) return;
    
    isDraggingRef.current = true;
    setIsDraggingUI(true);
    const bounds = progressBarRef.current.getBoundingClientRect();
    
    const updateTime = (clientX: number) => {
      const percent = Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width));
      const newTime = percent * duration;
      if (progressFillRef.current) progressFillRef.current.style.width = `${percent * 100}%`;
      if (currentTimeTextRef.current) currentTimeTextRef.current.textContent = formatTime(newTime);
      return newTime;
    };
    
    updateTime(e.clientX);
    
    const onPointerMove = (moveEvent: PointerEvent) => {
      updateTime(moveEvent.clientX);
    };
    
    const onPointerUp = (upEvent: PointerEvent) => {
      isDraggingRef.current = false;
      setIsDraggingUI(false);
      const finalTime = updateTime(upEvent.clientX);
      
      // Debounce seek to prevent spamming network requests if user clicks rapidly
      if (seekTimeoutRef.current) {
        clearTimeout(seekTimeoutRef.current);
      }
      seekTimeoutRef.current = setTimeout(() => {
        const active = getActiveAudio();
        if (active) {
          if (playbackStatus === 'error-needs-manual-resume') {
            setPendingResumeTime(finalTime);
          } else {
            active.currentTime = finalTime;
          }
        }
      }, 250);

      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
    
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  const handleVolumePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!volumeBarRef.current) return;
    const bounds = volumeBarRef.current.getBoundingClientRect();
    
    const updateVolume = (clientX: number) => {
      const percent = Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width));
      setVolume(percent);
      if (percent > 0) setIsMuted(false);
    };
    
    updateVolume(e.clientX);
    
    const onPointerMove = (moveEvent: PointerEvent) => {
      updateVolume(moveEvent.clientX);
    };
    
    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
    
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  const toggleMute = () => {
    setIsMuted(!isMuted);
  };

  const renderVolumeIcon = () => {
    if (isMuted || volume === 0) return <VolumeX className="w-5 h-5 text-gray-500 hover:text-white cursor-pointer transition-colors" onClick={toggleMute} />;
    if (volume < 0.33) return <Volume className="w-5 h-5 text-gray-500 hover:text-white cursor-pointer transition-colors" onClick={toggleMute} />;
    if (volume < 0.66) return <Volume1 className="w-5 h-5 text-gray-500 hover:text-white cursor-pointer transition-colors" onClick={toggleMute} />;
    return <Volume2 className="w-5 h-5 text-gray-500 hover:text-white cursor-pointer transition-colors" onClick={toggleMute} />;
  };

  const volumePercent = isMuted ? 0 : volume * 100;

  return (
    <div className="h-20 bg-white dark:bg-[#202124] flex items-center justify-between px-2 sm:px-4 shrink-0 z-10 transition-colors duration-300 relative">
      {/* Track Info (Left) */}
      <div className="flex items-center w-[30%] min-w-[140px] sm:min-w-[180px] justify-start pr-2">
        <div 
          className="flex items-center gap-2 sm:gap-4 cursor-pointer group py-1.5 pl-1.5 pr-2 sm:pr-4 -ml-1.5 rounded-xl hover:bg-gray-100 dark:hover:bg-[#2a2b2f] transition-colors min-w-0 flex-1 max-w-[320px]"
          onClick={() => currentTrack && onExpandNowPlaying()}
          onContextMenu={(e) => {
            e.preventDefault();
            if (currentTrack?.id) {
               window.dispatchEvent(new CustomEvent('locate-file', {
                 detail: { 
                   fileId: currentTrack.id,
                   parentId: currentTrack.parentId,
                   parentName: currentTrack.parentName
                 }
               }));
            }
          }}
          title={t('player.view_now_playing', 'Xem Đang Phát')}
        >
          <div className={`relative w-12 h-12 rounded-md shrink-0 transition-colors flex items-center justify-center overflow-hidden ${currentTrack && !coverUrl ? 'bg-gradient-to-br from-[#4285F4] to-[#34A853]' : 'bg-gray-200 dark:bg-[#121212]'}`}>
            {coverUrl ? (
              <img src={coverUrl} alt="Cover" className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-110 group-hover:brightness-75" />
            ) : currentTrack ? (
              <Music className="w-6 h-6 text-white opacity-80 transition-transform duration-300 group-hover:scale-110" />
            ) : null}
            
            {currentTrack && (
              <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity duration-200">
                <Maximize2 className="w-5 h-5 text-white" />
              </div>
            )}
          </div>
          <div className="overflow-hidden flex-1">
            <h4 className="font-medium text-sm text-gray-900 dark:text-gray-100 truncate group-hover:text-[#4285F4] transition-colors">
              {currentTrack ? realTitle : t('player.no_track')}
            </h4>
            <p className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-2 overflow-hidden whitespace-nowrap text-ellipsis">
              <span className="truncate">{currentTrack ? (realArtist || t('unknown_artist')) : ""}</span>
              {errorText && <span className="text-[10px] text-red-500 shrink-0" title={errorText}>{errorText}</span>}
            </p>
          </div>
        </div>
        
        {/* Heart Icon & More Menu */}
        {currentTrack && (
          <div className="hidden lg:flex items-center gap-1 shrink-0 ml-2">
            <button 
              onClick={toggleFavorite}
              className={`transition-all duration-200 hover:scale-110 p-1 ${isLiked ? 'text-[#4285F4]' : 'text-gray-400 hover:text-gray-900 dark:hover:text-white'}`}
            >
              <Heart className="w-5 h-5" fill={isLiked ? "currentColor" : "none"} />
            </button>
            <MoreMenu track={currentTrack} isPlayerBarMode={true} />
          </div>
        )}
      </div>

      {/* Center controls */}
      <div className="flex flex-col items-center justify-center flex-1 max-w-[722px] px-2 min-w-[200px]">
        <div className="flex w-full mb-1 items-center justify-center gap-3 sm:gap-6">
          <button 
            onClick={handlePrevClick}
            className="text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#2a2b2f] p-2 rounded-full transition-all active:scale-[0.92] disabled:opacity-50 disabled:hover:bg-transparent shrink-0"
            disabled={!currentTrack}
          >
            <SkipBack className="w-5 h-5" />
          </button>
          
          <button 
            onClick={() => {
              if (playbackStatus === 'error-needs-manual-resume') {
                handleManualResume();
              } else {
                onTogglePlay();
              }
            }}
            className={`w-10 h-10 shrink-0 flex items-center justify-center text-white rounded-full transition-all duration-200 shadow-md active:scale-90 ${currentTrack ? 'bg-[#4285F4] hover:bg-blue-600 hover:shadow-lg' : 'bg-gray-400 cursor-not-allowed'}`}
            disabled={!currentTrack || isDownloading}
          >
            {isDownloading ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : isPlaying && playbackStatus !== 'error-needs-manual-resume' ? (
              <Pause className="w-5 h-5" />
            ) : (
              <Play className="w-5 h-5 ml-0.5" />
            )}
          </button>

          <button 
            onClick={handleNextClick}
            className="text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#2a2b2f] p-2 rounded-full transition-all active:scale-[0.92] disabled:opacity-50 disabled:hover:bg-transparent shrink-0"
            disabled={!currentTrack}
          >
            <SkipForward className="w-5 h-5" />
          </button>
          
          <div className="relative group flex items-center shrink-0">
            <button 
              onClick={onTogglePlayMode}
              className={`p-2 rounded-full transition-all active:scale-[0.92] disabled:opacity-50 disabled:hover:bg-transparent shrink-0 ${playMode !== 'normal' ? 'text-[#4285F4] hover:bg-[#4285F4]/10' : 'text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#2a2b2f]'}`}
              disabled={!currentTrack}
            >
              {playMode === 'shuffle' && <Shuffle className="w-5 h-5" />}
              {playMode === 'repeat-all' && <Repeat className="w-5 h-5" />}
              {playMode === 'repeat-one' && <Repeat1 className="w-5 h-5" />}
              {playMode === 'normal' && <Repeat className="w-5 h-5 opacity-40" />}
            </button>
            <div className="absolute top-full mt-3 left-1/2 -translate-x-1/2 bg-white dark:bg-[#2a2b2f] text-gray-800 dark:text-gray-200 text-xs py-1.5 px-3 rounded-md shadow-xl opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-50 font-medium">
              {playMode === 'shuffle' ? 'Shuffle' : playMode === 'repeat-all' ? 'Repeat All' : playMode === 'repeat-one' ? 'Repeat One' : 'Normal Order'}
              {/* Tooltip triangle */}
              <div className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-3 h-3 bg-white dark:bg-[#2a2b2f] rotate-45"></div>
            </div>
          </div>
        </div>
        <div className="w-full flex items-center gap-3">
          <span ref={currentTimeTextRef} className="text-xs text-gray-500 min-w-[52px] text-right tabular-nums">0:00</span>
          <div 
            ref={progressBarRef}
            className="flex-1 h-1.5 bg-gray-200 dark:bg-[#2A2A2A] rounded-full cursor-pointer group relative flex items-center"
            onPointerDown={handlePointerDown}
          >
            {/* Buffered Bar */}
            <div 
              ref={bufferFillRef}
              className="absolute left-0 h-full bg-gray-400 dark:bg-gray-500 rounded-full transform-gpu will-change-[width]"
            ></div>
            
            {/* Played Bar */}
            <div 
              ref={progressFillRef}
              className={`absolute left-0 h-full bg-[#4285F4] rounded-full flex items-center transform-gpu will-change-[width]`}
            >
              {/* Knob (luôn hiển thị) */}
              <div className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 w-3 h-3 bg-white rounded-full shadow shrink-0"></div>
            </div>
          </div>
          <span className="text-xs text-gray-500 min-w-[52px] tabular-nums">{formatTime(duration)}</span>
        </div>
      </div>

      {/* Right Controls */}
      <div className="flex items-center justify-end w-[30%] min-w-[120px] pl-2 gap-3">
        {renderVolumeIcon()}
        <div 
          ref={volumeBarRef}
          className="hidden xl:flex w-16 sm:w-24 h-1.5 bg-gray-200 dark:bg-[#2A2A2A] rounded-full cursor-pointer relative group items-center"
          onPointerDown={handleVolumePointerDown}
        >
          <div 
            className={`absolute left-0 h-full bg-gray-500 dark:bg-gray-400 group-hover:bg-[#4285F4] ${isVolumeActive ? '!bg-[#4285F4]' : ''} rounded-full transition-colors`}
            style={{ width: `${volumePercent}%` }}
          >
            <div className={`absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 w-3 h-3 bg-white rounded-full shadow opacity-0 group-hover:opacity-100 ${isVolumeActive ? '!opacity-100' : ''} transition-opacity shrink-0`}></div>
          </div>
        </div>
      </div>

      {/* Hidden Audio Elements */}
      <audio
        id="drplay-audio"
        ref={audioRef}
        preload="auto"
        onTimeUpdate={handleTimeUpdate}
        onProgress={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onCanPlay={handleCanPlay}
        onError={handleAudioError}
        onEnded={handleEnded}
      />
      <audio
        id="drplay-audio-2"
        ref={audioRef2}
        preload="auto"
        onTimeUpdate={handleTimeUpdate}
        onProgress={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onCanPlay={handleCanPlay}
        onError={handleAudioError}
        onEnded={handleEnded}
      />

      {/* Network Error Toast Portal */}
      {errorText && (
        errorText === t('player.network_interrupted', 'Mạng không ổn định hoặc mất kết nối, vui lòng kiểm tra lại') || 
        errorText === t('player.network_disconnected', 'Mạng không ổn định hoặc mất kết nối, vui lòng kiểm tra lại')
      ) && createPortal(
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 bg-gray-900/90 backdrop-blur-md text-white text-sm px-6 py-3 rounded-full shadow-2xl flex items-center gap-3 z-50 animate-in fade-in slide-in-from-bottom-4 duration-300 w-max max-w-[90vw]">
          <WifiOff className="w-5 h-5 text-yellow-400 shrink-0" />
          <span className="font-medium text-center">{errorText}</span>
        </div>,
        document.body
      )}
    </div>
  );
}
