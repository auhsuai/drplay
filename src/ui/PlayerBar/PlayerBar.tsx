import { memo, useRef, useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { CloudOff, FileWarning, WifiOff, Play, Pause, SkipBack, SkipForward, Volume2, Volume1, Volume, VolumeX, Loader2, Music, Shuffle, Repeat, Repeat1, Maximize2, RefreshCw, Heart } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MoreMenu } from '../components/MoreMenu';
import { formatTime } from "../../utils/formatTime";
import { updateBufferBar, clearBufferBar } from "../../utils/bufferedRange";
import { captureError } from "../../utils/errorLog";
import { isFavorite, addFavorite, removeFavorite } from "../../utils/favorites";
import { AudioController } from "../../lib/AudioController";
import { PlayerBarProps } from './types';

const PLAYER_BAR_MODULE = 'PlayerBar';

// Các helper function nhỏ gọn
function ErrorIcon({ type, className = "w-5 h-5 shrink-0" }: { type: string; className?: string }) {
  const Icon = type === 'rate_limited' || type === 'drive_quota_exceeded' || type === 'download_quota' ? CloudOff : type === 'file_deleted' || type === 'format_error' || type === 'access_denied' ? FileWarning : WifiOff;
  return <Icon className={`${className} text-[#4285F4]`} />;
}

function PlayerBarImpl({ currentTrack, isPlaying, onTogglePlay, onNextTrack, onPrevTrack, isDownloading, loadNonce, playMode, onTogglePlayMode, onExpandNowPlaying }: PlayerBarProps) {
  const { t } = useTranslation();
  
  // Local UI state (không gây ảnh hưởng global)
  const [duration, setDuration] = useState(0);
  const [isBuffering, setIsBuffering] = useState(false);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isVolumeActive, setIsVolumeActive] = useState(false);
  const [errorInfo, setErrorInfo] = useState<{ message: string, code: string } | null>(null);
  const [isLiked, setIsLiked] = useState(false);

  const toggleMute = useCallback(() => {
    setIsMuted(AudioController.getInstance().toggleMute());
  }, []);

  // Refs for high-performance DOM updates
  const progressFillRef = useRef<HTMLDivElement>(null);
  const bufferFillRef = useRef<HTMLDivElement>(null);
  const currentTimeTextRef = useRef<HTMLSpanElement>(null);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const volumeBarRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  
  const audio = AudioController.getInstance();

  // Reset transient track state when the track changes
  const prevTrackIdRef = useRef<string | undefined>(undefined);
  if (currentTrack?.id !== prevTrackIdRef.current) {
    prevTrackIdRef.current = currentTrack?.id;
    if (errorInfo) setErrorInfo(null);
  }

  // Subscribe to AudioController Events
  useEffect(() => {
    const unsubTime = audio.on('timeupdate', ({ currentTime, duration }) => {
      setDuration(duration);
      if (isDraggingRef.current) return;
      if (currentTimeTextRef.current) currentTimeTextRef.current.textContent = formatTime(currentTime);
      if (progressFillRef.current && duration > 0) {
        progressFillRef.current.style.width = `${(currentTime / duration) * 100}%`;
      }
      // Buffer bar fallback: the last native `progress` event can fire with
      // buffered still empty before a small/fast file finishes loading (no
      // further progress event ever fires). timeupdate (~4/s) re-reads the
      // real buffered state so the bar cannot stay empty once it's full.
      // DOM-only — no React re-render.
      updateBufferBar(bufferFillRef.current, audio.getBuffered());
    });

    const unsubBuf = audio.on('buffering', ({ isBuffering }) => setIsBuffering(isBuffering));
    const unsubErr = audio.on('error', (err) => setErrorInfo(err));
    const unsubEnded = audio.on('ended', () => onNextTrack(true));
    // Buffer bar: the native `progress` event fires whenever audio.buffered
    // grows (paused or playing) — the industry-standard source (MDN).
    const unsubProgress = audio.on('progress', () => {
      updateBufferBar(bufferFillRef.current, audio.getBuffered());
    });

    return () => {
      unsubTime();
      unsubBuf();
      unsubErr();
      unsubEnded();
      unsubProgress();
    };
  }, [onNextTrack]);

  // Handle Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement as HTMLElement;
      if (activeEl?.tagName === 'INPUT' || activeEl?.tagName === 'TEXTAREA' || activeEl?.isContentEditable) return;

      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          audio.seek(Math.max(0, audio.getCurrentTime() - 5));
          // Redraw immediately instead of clearing: updateBufferBar already
          // drops stale pre-seek ranges, and clearing first would flash an
          // empty bar for a frame before the next progress event (blink on
          // every seek).
          updateBufferBar(bufferFillRef.current, audio.getBuffered());
          break;
        case 'ArrowRight':
          e.preventDefault();
          audio.seek(Math.min(audio.getDuration(), audio.getCurrentTime() + 5));
          updateBufferBar(bufferFillRef.current, audio.getBuffered());
          break;
        case 'ArrowUp':
          e.preventDefault();
          setVolume(prev => {
            const nv = Math.min(1, prev + 0.1);
            audio.setVolume(nv);
            return nv;
          });
          break;
        case 'ArrowDown':
          e.preventDefault();
          setVolume(prev => {
            const nv = Math.max(0, prev - 0.1);
            audio.setVolume(nv);
            return nv;
          });
          break;
        case 'm': case 'M':
          e.preventDefault();
          toggleMute();
          break;
        case 'n': case 'N':
          e.preventDefault();
          onNextTrack(false);
          break;
        case 'p': case 'P':
          e.preventDefault();
          onPrevTrack();
          break;
        case 's': case 'S':
          e.preventDefault();
          onTogglePlayMode();
          break;
        case ' ':
          e.preventDefault();
          onTogglePlay();
          break;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onNextTrack, onPrevTrack, onTogglePlay, onTogglePlayMode, toggleMute]);

  // Handle Play/Pause from Props (Syncing)
  useEffect(() => {
    if (!currentTrack) return;
    if (isPlaying) {
      audio.playTrack(currentTrack, currentTrack.restoreTime);
    } else {
      audio.pause();
    }
  }, [isPlaying, currentTrack, loadNonce]);

  // Sync initial UI state from restored session data
  useEffect(() => {
    if (bufferFillRef.current) clearBufferBar(bufferFillRef.current);
    if (currentTrack) {
      if (currentTrack.restoreDuration) setDuration(currentTrack.restoreDuration);
      
      const time = currentTrack.restoreTime || 0;
      const dur = currentTrack.restoreDuration || duration || 0;
      
      if (currentTimeTextRef.current) currentTimeTextRef.current.textContent = formatTime(time);
      if (progressFillRef.current && dur > 0) {
        progressFillRef.current.style.width = `${(time / dur) * 100}%`;
      } else if (progressFillRef.current) {
        progressFillRef.current.style.width = '0%';
      }
    } else {
      setDuration(0);
      if (currentTimeTextRef.current) currentTimeTextRef.current.textContent = "0:00";
      if (progressFillRef.current) progressFillRef.current.style.width = "0%";
    }
  }, [currentTrack]);

  // Shared favorite-status check: re-reads the stored status for a track id
  // and applies it, unless the requesting scope went stale (track changed /
  // component unmounted) while the check was in flight.
  const checkFavorite = useCallback(async (trackId: string, isStale: () => boolean) => {
    try {
      const liked = await isFavorite(trackId);
      if (!isStale()) setIsLiked(liked);
    } catch (e: unknown) {
      captureError({ level: 'warn', source: PLAYER_BAR_MODULE, message: `check-favorite-failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  }, []);

  // Check favorite status whenever the current track changes
  useEffect(() => {
    let cancelled = false;
    if (!currentTrack) { setIsLiked(false); return; }
    checkFavorite(currentTrack.id, () => cancelled);
    return () => { cancelled = true; };
  }, [currentTrack?.id, checkFavorite]);

  // Re-check the current track when favorites change elsewhere (favorites.ts
  // dispatches `favorites-updated` on add/remove), so the heart never shows a
  // stale state while the same track keeps playing.
  useEffect(() => {
    const handleFavoritesUpdated = () => {
      if (!currentTrack) return;
      checkFavorite(currentTrack.id, () => false);
    };
    window.addEventListener('favorites-updated', handleFavoritesUpdated);
    return () => window.removeEventListener('favorites-updated', handleFavoritesUpdated);
  }, [currentTrack?.id, checkFavorite]);

  const isFavoriteTogglingRef = useRef(false);
  const handleToggleFavorite = async () => {
    if (!currentTrack || isFavoriteTogglingRef.current) return;
    isFavoriteTogglingRef.current = true;
    try {
      if (isLiked) {
        await removeFavorite(currentTrack.id);
      } else {
        await addFavorite(currentTrack);
      }
      setIsLiked(!isLiked);
    } catch (e: unknown) {
      captureError({ level: 'error', source: PLAYER_BAR_MODULE, message: `toggle-favorite-failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      isFavoriteTogglingRef.current = false;
    }
  };

  // Volume control
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!progressBarRef.current || duration === 0) return;
    try {
      progressBarRef.current.setPointerCapture(e.pointerId);
    } catch (err) {
      captureError({ level: 'warn', source: PLAYER_BAR_MODULE, message: `set-pointer-capture-failed: ${err instanceof Error ? err.message : String(err)}` });
    }
    
    const bounds = progressBarRef.current.getBoundingClientRect();
    const updateTime = (clientX: number) => {
      const percent = Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width));
      if (progressFillRef.current) progressFillRef.current.style.width = `${percent * 100}%`;
      if (currentTimeTextRef.current) currentTimeTextRef.current.textContent = formatTime(percent * duration);
      return percent * duration;
    };

    isDraggingRef.current = true;
    updateTime(e.clientX);
    
    const onMove = (moveEvent: PointerEvent) => updateTime(moveEvent.clientX);
    const commit = (upEvent: PointerEvent) => {
      audio.seek(updateTime(upEvent.clientX));
      // Redraw immediately (not clear): updateBufferBar drops stale pre-seek
      // ranges, so an immediate redraw shows the real buffer at the new
      // position without the empty-bar blink a clear would cause.
      updateBufferBar(bufferFillRef.current, audio.getBuffered());
      // Give the audio engine a small window to flush old timeupdate events
      setTimeout(() => {
        isDraggingRef.current = false;
      }, 150);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
    const onUp = (upEvent: PointerEvent) => commit(upEvent);
    const onCancel = (cancelEvent: PointerEvent) => commit(cancelEvent);

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  };

  const handleVolumePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!volumeBarRef.current) return;
    const bounds = volumeBarRef.current.getBoundingClientRect();
    
    const updateVol = (clientX: number) => {
      const percent = Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width));
      setVolume(percent);
      audio.setVolume(percent);
      if (percent > 0) setIsMuted(false);
      setIsVolumeActive(true);
    };

    updateVol(e.clientX);
    const onMove = (moveEvent: PointerEvent) => {
      updateVol(moveEvent.clientX);
    };
    const onUp = () => {
      setIsVolumeActive(false);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const volumePercent = isMuted ? 0 : volume * 100;

  const renderVolumeIcon = () => {
    if (isMuted || volume === 0) return <VolumeX className="w-5 h-5 text-gray-500 hover:text-white cursor-pointer" onClick={toggleMute} />;
    if (volume < 0.33) return <Volume className="w-5 h-5 text-gray-500 hover:text-white cursor-pointer" onClick={toggleMute} />;
    if (volume < 0.66) return <Volume1 className="w-5 h-5 text-gray-500 hover:text-white cursor-pointer" onClick={toggleMute} />;
    return <Volume2 className="w-5 h-5 text-gray-500 hover:text-white cursor-pointer" onClick={toggleMute} />;
  };

  const realTitle = currentTrack?.title || t('player.no_track');
  const realArtist = currentTrack?.artist || t('unknown_artist');

  return (
    <div className="h-20 bg-white dark:bg-[#202124] flex items-center justify-between px-2 sm:px-4 shrink-0 z-10 transition-colors duration-300 relative">
      {/* Left: Track Info */}
      <div className="flex items-center w-[30%] min-w-[140px] sm:min-w-[180px] justify-start pr-2">
        <div 
          className="flex items-center gap-2 sm:gap-4 cursor-pointer group py-1.5 pl-1.5 pr-2 sm:pr-4 -ml-1.5 rounded-xl hover:bg-gray-100 dark:hover:bg-[#2a2b2f] transition-colors min-w-0 flex-1 max-w-[320px]"
          onClick={() => currentTrack && onExpandNowPlaying()}
          title={t('player.view_now_playing', 'Xem Đang Phát')}
        >
          <div className={`relative w-12 h-12 rounded-lg shrink-0 transition-colors flex items-center justify-center overflow-hidden bg-gray-200 dark:bg-[#121212] text-gray-400`}>
            {currentTrack ? (
              <Music className="w-6 h-6 opacity-80 transition-transform duration-300 group-hover:scale-110" />
            ) : null}
            {currentTrack && (
              <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity duration-200">
                <Maximize2 className="w-5 h-5 text-white" />
              </div>
            )}
          </div>
          <div className="overflow-hidden flex-1">
            <h4 className="font-medium text-sm text-gray-900 dark:text-gray-100 truncate group-hover:text-[#4285F4] transition-colors">
              {realTitle}
            </h4>
            <p className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-2 overflow-hidden whitespace-nowrap text-ellipsis">
              <span className="truncate">{currentTrack ? realArtist : ""}</span>
            </p>
          </div>
        </div>
        {currentTrack && (
          <div className="hidden lg:flex items-center gap-1 shrink-0 ml-2">
            <button
              type="button"
              onClick={handleToggleFavorite}
              aria-label={isLiked ? t('player.remove_favorite', 'Remove from favorites') : t('player.add_favorite', 'Add to favorites')}
              className={`transition-all duration-200 hover:scale-110 p-1 ${isLiked ? 'text-[#4285F4]' : 'text-gray-400 hover:text-gray-900 dark:hover:text-white'}`}
            >
              <Heart className="w-5 h-5" fill={isLiked ? "currentColor" : "none"} />
            </button>
            <MoreMenu track={currentTrack} isPlayerBarMode={true} />
          </div>
        )}
      </div>

      {/* Center: Controls */}
      <div className="flex flex-col items-center justify-center flex-1 max-w-[722px] px-2 min-w-[200px]">
        <div className="flex w-full mb-1 items-center justify-center gap-3 sm:gap-6">
          <button 
            onClick={() => onPrevTrack()}
            className="text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#2a2b2f] p-2 rounded-full transition-all active:scale-[0.92] disabled:opacity-50 disabled:hover:bg-transparent shrink-0"
            disabled={!currentTrack}
          >
            <SkipBack className="w-5 h-5" />
          </button>
          
          <button 
            onClick={errorInfo ? () => audio.playTrack(currentTrack!) : onTogglePlay}
            className={`w-10 h-10 shrink-0 flex items-center justify-center text-white rounded-full transition-all duration-200 shadow-md active:scale-90 ${currentTrack ? 'bg-[#4285F4] hover:bg-blue-600 hover:shadow-lg' : 'bg-gray-400 cursor-not-allowed'}`}
            disabled={!currentTrack || isDownloading}
          >
            {isDownloading || (isBuffering && isPlaying && !errorInfo) ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : errorInfo ? (
              <RefreshCw className="w-5 h-5" />
            ) : isPlaying ? (
              <Pause className="w-5 h-5" />
            ) : (
              <Play className="w-5 h-5 ml-0.5" />
            )}
          </button>

          <button 
            onClick={() => onNextTrack(false)}
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
          </div>
        </div>
        <div className="w-full flex items-center gap-3">
          <span ref={currentTimeTextRef} className="text-xs text-gray-500 min-w-[52px] text-right tabular-nums">0:00</span>
          <div 
            ref={progressBarRef}
            className="flex-1 h-1.5 bg-gray-200 dark:bg-[#2A2A2A] rounded-full cursor-pointer group relative flex items-center"
            onPointerDown={handlePointerDown}
          >
            <div 
              ref={bufferFillRef}
              data-testid="buffer-fill"
              className="absolute inset-0 overflow-hidden rounded-full pointer-events-none"
            ></div>
            <div 
              ref={progressFillRef}
              className={`absolute left-0 h-full bg-[#4285F4] rounded-full flex items-center transform-gpu will-change-[width]`}
            >
              <div className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 w-3 h-3 bg-white rounded-full shadow shrink-0"></div>
            </div>
          </div>
          <span className="text-xs text-gray-500 min-w-[52px] tabular-nums">{formatTime(duration)}</span>
        </div>
      </div>

      {/* Right: Volume Controls */}
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

      {/* Error Toast */}
      {errorInfo && createPortal(
        <div className="absolute top-[76px] left-0 h-11 bg-[#2a2b2f] text-white text-sm flex items-center z-50 select-none">
          <div className="flex items-center gap-3 px-4 flex-1 min-w-0">
            <ErrorIcon type={errorInfo.code} />
            <span className="font-medium truncate">{errorInfo.message}</span>
          </div>
          <div className="w-1.5 self-stretch bg-[#4285F4]" />
        </div>,
        document.getElementById('content-area') || document.body
      )}
    </div>
  );
}

export const PlayerBar = memo(PlayerBarImpl, (prevProps, nextProps) => {
  return (
    prevProps.currentTrack?.id === nextProps.currentTrack?.id &&
    prevProps.isPlaying === nextProps.isPlaying &&
    prevProps.playMode === nextProps.playMode &&
    prevProps.isDownloading === nextProps.isDownloading &&
    prevProps.loadNonce === nextProps.loadNonce
  );
});
