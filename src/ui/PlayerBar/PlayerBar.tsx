import React, { useRef, useState, useEffect } from "react";
import { Play, Pause, SkipBack, SkipForward, Volume2, Volume1, Volume, VolumeX, Loader2, Music, Shuffle, Repeat, Repeat1, Heart, Maximize2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Track } from "../../App";
import { getTrackMetadata, updateTrackDuration } from '../../utils/metadata';
import { recordPlay } from '../../utils/history';
import { isFavorite, addFavorite, removeFavorite } from '../../utils/favorites';
import { MoreMenu } from '../components/MoreMenu';
import { set as idbSet } from 'idb-keyval';
import { invoke } from '@tauri-apps/api/core';


const formatTime = (time: number) => {
  if (isNaN(time)) return "0:00";
  const hours = Math.floor(time / 3600);
  const minutes = Math.floor((time % 3600) / 60);
  const seconds = Math.floor(time % 60);
  
  if (hours > 0) {
    return `${hours}:${minutes < 10 ? "0" : ""}${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;
  }
  return `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;
};

interface PlayerBarProps {
  currentTrack: Track | null;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onNextTrack: () => void;
  onPrevTrack: () => void;
  isDownloading?: boolean;
  playMode: 'normal' | 'shuffle' | 'repeat-all' | 'repeat-one';
  onTogglePlayMode: () => void;
  onExpandNowPlaying: () => void;
  bufferSeconds: number;
}

export function PlayerBar({ currentTrack, isPlaying, onTogglePlay, onNextTrack, onPrevTrack, isDownloading, playMode, onTogglePlayMode, onExpandNowPlaying, bufferSeconds }: PlayerBarProps) {
  const { t } = useTranslation();
  const audioRef = useRef<HTMLAudioElement>(null);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const progressFillRef = useRef<HTMLDivElement>(null);
  const bufferFillRef = useRef<HTMLDivElement>(null);
  const currentTimeTextRef = useRef<HTMLSpanElement>(null);
  const volumeBarRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const [duration, setDuration] = useState(0);
  const [isDraggingUI, setIsDraggingUI] = useState(false);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isVolumeActive, setIsVolumeActive] = useState(false);
  const volumeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  
  const lastSaveTimeRef = useRef(0);
  const restoredAudioTrackIdRef = useRef<string | null>(null);
  const pendingBufferRestoreTimeRef = useRef<number | null>(null);

  // Sync like status when track changes
  useEffect(() => {
    if (currentTrack) {
      isFavorite(currentTrack.id).then(setIsLiked);
    }
  }, [currentTrack?.id]);

  // Listen to global favorite updates
  useEffect(() => {
    const handleFavoritesUpdated = () => {
      if (currentTrack) {
        isFavorite(currentTrack.id).then(setIsLiked);
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
      } else {
         setDuration(0);
      }
      if (bufferFillRef.current) bufferFillRef.current.style.width = '0%';
    }
  }, [currentTrack?.id]);

  useEffect(() => {
    if (currentTrack) {
      let isCancelled = false;
      let objectUrl: string | null = null;
      
      getTrackMetadata(currentTrack.id, currentTrack.streamUrl || undefined)
        .then(metadata => {
          if (isCancelled) return;
          if (metadata.title) setRealTitle(metadata.title);
          if (metadata.artist) setRealArtist(metadata.artist);
          
          if (metadata.coverUrl) {
            setCoverUrl(metadata.coverUrl.startsWith('http://127') ? metadata.coverUrl + '&thumb=true' : metadata.coverUrl);
          } else if (metadata.pictureData && metadata.pictureFormat) {
            const blob = new Blob([new Uint8Array(metadata.pictureData)], { type: metadata.pictureFormat });
            objectUrl = URL.createObjectURL(blob);
            setCoverUrl(objectUrl);
          }
        })
        .catch(err => {
          if (!isCancelled) setErrorText(err.message);
        });
        
      if (currentTrack.streamUrl) {
        recordPlay(currentTrack).catch(e => console.error("Failed to record play", e));
      }
      
      return () => {
        isCancelled = true;
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      };
    }
  }, [currentTrack?.id, currentTrack?.streamUrl]);

  const onTogglePlayRef = useRef(onTogglePlay);
  useEffect(() => {
    onTogglePlayRef.current = onTogglePlay;
  }, [onTogglePlay]);

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
          if (audioRef.current) {
            audioRef.current.currentTime = Math.max(0, audioRef.current.currentTime - 5);
          }
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (audioRef.current) {
            audioRef.current.currentTime = Math.min(audioRef.current.duration || 0, audioRef.current.currentTime + 5);
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
        case ' ':
          e.preventDefault();
          onTogglePlayRef.current();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = isMuted ? 0 : volume;
    }
  }, [volume, isMuted, currentTrack]);

  useEffect(() => {
    if (audioRef.current) {
      if (isPlaying) {
        const playPromise = audioRef.current.play();
        if (playPromise !== undefined) {
          playPromise.catch((e) => console.error("Playback failed", e));
        }
      } else {
        audioRef.current.pause();
      }
    }
  }, [isPlaying]);

  const handleTimeUpdate = () => {
    if (audioRef.current && !isDraggingRef.current) {
      const time = audioRef.current.currentTime;
      
      const now = Date.now();
      if (now - lastSaveTimeRef.current > 2000 && currentTrack) {
        idbSet('drplay_last_session', {
          track: currentTrack,
          time,
          duration: audioRef.current.duration || duration
        });
        lastSaveTimeRef.current = now;
      }
    }
  };

  const handleLoadedMetadata = () => {
    if (audioRef.current) {
      const accurateDuration = audioRef.current.duration;
      setDuration(accurateDuration);
      if (currentTrack) {
        updateTrackDuration(currentTrack.id, accurateDuration);
      }

      if (pendingBufferRestoreTimeRef.current !== null) {
        audioRef.current.currentTime = pendingBufferRestoreTimeRef.current;
        pendingBufferRestoreTimeRef.current = null;
      }

      if (currentTrack && currentTrack.restoreTime !== undefined && restoredAudioTrackIdRef.current !== currentTrack.id) {
        audioRef.current.currentTime = currentTrack.restoreTime;
        restoredAudioTrackIdRef.current = currentTrack.id;
      }
    }
  };

  // Handle immediate buffer changes continuously
  const prevBufferSecondsRef = useRef(bufferSeconds);
  useEffect(() => {
    if (bufferSeconds !== prevBufferSecondsRef.current) {
      prevBufferSecondsRef.current = bufferSeconds;
      
      // Update global buffer capacity in backend immediately without interrupting stream
      invoke("update_buffer_settings", { seconds: bufferSeconds }).catch(console.error);
    }
  }, [bufferSeconds]);

  // Save session immediately on track change and on exit
  useEffect(() => {
    const saveSession = () => {
      if (!currentTrack) return;
      
      let timeToSave = audioRef.current?.currentTime || 0;
      let durationToSave = duration;
      
      if (audioRef.current && currentTrack.streamUrl) {
         timeToSave = audioRef.current.currentTime || timeToSave;
         durationToSave = audioRef.current.duration || durationToSave;
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

  // Bulletproof Interval to update buffer percent
  useEffect(() => {
    const interval = setInterval(async () => {
      let newBufferedPercent = 0;
      try {
        const [basePos, dataLen, totalLen] = await invoke<[number, number, number | null]>("get_proxy_cache_status");
        if (totalLen && totalLen > 0 && audioRef.current) {
          const maxBufferedPos = basePos + dataLen;
          const bufferedEndRatio = maxBufferedPos / totalLen;
          const currentDuration = audioRef.current.duration || duration;
          
          if (currentDuration > 0) {
            const currentTime = audioRef.current.currentTime;
            const maxAllowedTime = currentTime + bufferSeconds;
            const maxAllowedRatio = maxAllowedTime / currentDuration;
            newBufferedPercent = Math.min(100, Math.min(bufferedEndRatio, maxAllowedRatio) * 100);
          } else {
            newBufferedPercent = Math.min(100, bufferedEndRatio * 100);
          }
        } else if (audioRef.current) {
          // Fallback to HTML5 audio buffer
          const buffered = audioRef.current.buffered;
          const currentDuration = audioRef.current.duration || duration;
          if (currentDuration > 0 && buffered.length > 0) {
            const furthestBuffer = buffered.end(buffered.length - 1);
            newBufferedPercent = Math.min(100, (furthestBuffer / currentDuration) * 100);
          }
        }
      } catch (e) {
        // Fallback if backend doesn't support command yet
        if (audioRef.current) {
          const buffered = audioRef.current.buffered;
          const currentDuration = audioRef.current.duration || duration;
          if (currentDuration > 0 && buffered.length > 0) {
            const furthestBuffer = buffered.end(buffered.length - 1);
            newBufferedPercent = Math.min(100, (furthestBuffer / currentDuration) * 100);
          }
        }
      }
      if (bufferFillRef.current) {
        bufferFillRef.current.style.width = `${newBufferedPercent}%`;
      }
    }, 500);
    return () => clearInterval(interval);
  }, [duration, bufferSeconds]);

  useEffect(() => {
    let lastTimeText = "";
    let lastProgressWidth = "";
    const audio = audioRef.current;
    
    const updateProgressUI = () => {
      if (audio && !isDraggingRef.current && progressFillRef.current && currentTimeTextRef.current) {
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

    if (audio) {
      audio.addEventListener('timeupdate', updateProgressUI);
      updateProgressUI(); // initial update
      
      return () => {
        audio.removeEventListener('timeupdate', updateProgressUI);
      };
    }
  }, [duration, currentTrack]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!audioRef.current || duration === 0 || !progressBarRef.current) return;
    
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
      if (audioRef.current) {
        audioRef.current.currentTime = finalTime;
      }
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
    <div className="h-20 bg-white dark:bg-[#202124] flex items-center justify-between px-6 shrink-0 z-10 transition-colors duration-300 relative">
      <div className="flex items-center gap-4 w-1/4 max-w-[25%] min-w-0">
        <div 
          className="flex items-center gap-4 flex-1 cursor-pointer group p-1 -ml-1 rounded-lg hover:bg-gray-100 dark:hover:bg-[#2a2b2f] transition-colors min-w-0"
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
              <span>{currentTrack ? (realArtist || t('unknown_artist')) : ""}</span>
              {errorText && <span className="text-[10px] text-red-500 shrink-0" title={errorText}>{errorText}</span>}
            </p>
          </div>
        </div>
        
        {/* Heart Icon & More Menu */}
        {currentTrack && (
          <div className="flex items-center gap-1 shrink-0 ml-2">
            <button 
              onClick={toggleFavorite}
              className={`transition-all duration-200 hover:scale-110 p-1 ${isLiked ? 'text-[#4285F4]' : 'text-gray-400 hover:text-gray-900 dark:hover:text-white'}`}
            >
              <Heart className="w-5 h-5" fill={isLiked ? "currentColor" : "none"} />
            </button>
            <MoreMenu track={currentTrack} />
          </div>
        )}
      </div>

      {/* Center controls */}
      <div className="flex-1 flex flex-col items-center justify-center max-w-[40%] relative z-10">
        <div className="flex items-center gap-6 mb-1">
          <button 
            onClick={onPrevTrack}
            className="text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#2a2b2f] p-2 rounded-full transition-all active:scale-[0.92] disabled:opacity-50 disabled:hover:bg-transparent"
            disabled={!currentTrack}
          >
            <SkipBack className="w-5 h-5" />
          </button>
          
          <button 
            onClick={onTogglePlay}
            className={`w-10 h-10 flex items-center justify-center text-white rounded-full transition-all duration-200 shadow-md active:scale-90 ${currentTrack ? 'bg-[#4285F4] hover:bg-blue-600 hover:shadow-lg' : 'bg-gray-400 cursor-not-allowed'}`}
            disabled={!currentTrack || isDownloading}
          >
            {isDownloading ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : isPlaying ? (
              <Pause className="w-5 h-5" />
            ) : (
              <Play className="w-5 h-5 ml-0.5" />
            )}
          </button>

          <button 
            onClick={onNextTrack}
            className="text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#2a2b2f] p-2 rounded-full transition-all active:scale-[0.92] disabled:opacity-50 disabled:hover:bg-transparent"
            disabled={!currentTrack}
          >
            <SkipForward className="w-5 h-5" />
          </button>
          
          <div className="relative group flex items-center">
            <button 
              onClick={onTogglePlayMode}
              className={`p-2 rounded-full transition-all active:scale-[0.92] disabled:opacity-50 disabled:hover:bg-transparent ml-2 ${playMode !== 'normal' ? 'text-[#4285F4] hover:bg-[#4285F4]/10' : 'text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#2a2b2f]'}`}
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
          <span ref={currentTimeTextRef} className="text-xs text-gray-500 w-10 text-right">0:00</span>
          <div 
            ref={progressBarRef}
            className="flex-1 h-1.5 bg-gray-200 dark:bg-[#2A2A2A] rounded-full cursor-pointer group relative flex items-center"
            onPointerDown={handlePointerDown}
          >
            {/* Buffered Bar */}
            <div 
              ref={bufferFillRef}
              className="absolute left-0 h-full bg-gray-400 dark:bg-gray-500 rounded-full transition-all duration-300 transform-gpu will-change-[width]"
            ></div>
            
            {/* Played Bar */}
            <div 
              ref={progressFillRef}
              className={`absolute left-0 h-full bg-[#4285F4] rounded-full flex items-center transform-gpu will-change-[width] ${isDraggingUI ? '' : 'transition-all duration-150'}`}
            >
              {/* Knob (luôn hiển thị) */}
              <div className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 w-3 h-3 bg-white rounded-full shadow shrink-0"></div>
            </div>
          </div>
          <span className="text-xs text-gray-500 w-10">{formatTime(duration)}</span>
        </div>
      </div>

      {/* Right Controls */}
      <div className="flex items-center gap-3 w-1/4 justify-end">
        {renderVolumeIcon()}
        <div 
          ref={volumeBarRef}
          className="w-24 h-1.5 bg-gray-200 dark:bg-[#2A2A2A] rounded-full cursor-pointer relative group flex items-center"
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

      {/* Hidden Audio Element */}
      {currentTrack && currentTrack.streamUrl && (
        <audio
          id="drplay-audio"
          ref={audioRef}
          src={currentTrack.streamUrl}
          preload="metadata"
          autoPlay={isPlaying}
          onTimeUpdate={handleTimeUpdate}
          onProgress={handleTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
          onEnded={() => {
            if (playMode === 'repeat-one') {
              if (audioRef.current) {
                audioRef.current.currentTime = 0;
                audioRef.current.play().catch(e => console.error("Replay failed", e));
              }
            } else {
              onNextTrack();
            }
          }}
        />
      )}
    </div>
  );
}
