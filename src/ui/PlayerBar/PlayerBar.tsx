import { memo, useRef, useState, useEffect, useReducer, useCallback } from "react";
import { createPortal } from "react-dom";
import { CloudOff, FileWarning, WifiOff, Play, Pause, SkipBack, SkipForward, Volume2, Volume1, Volume, VolumeX, Loader2, Music, Shuffle, Repeat, Repeat1, Heart, Maximize2, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MoreMenu } from '../components/MoreMenu';
import { formatTime } from "../../utils/formatTime";

import { initialPlayerState, playerReducer } from './playerReducer';
import { PlayerBarProps, toastTypes, bannerTypes } from './types';
import { useAudioEngine } from './useAudioEngine';
import { usePlaybackControl } from './usePlaybackControl';
import { useKeyboard } from './useKeyboard';
import { useTrackMetadata } from './useTrackMetadata';
import { useErrorDisplay } from './useErrorDisplay';
import { useProgressUI } from './useProgressUI';

function ErrorIcon({ type, className = "w-5 h-5 shrink-0" }: { type: string; className?: string }) {
  const Icon = type === 'rate_limited' || type === 'drive_quota_exceeded' || type === 'download_quota' ? CloudOff : type === 'file_deleted' || type === 'format_error' || type === 'access_denied' ? FileWarning : WifiOff;
  return <Icon className={`${className} text-[#4285F4]`} />;
}

function PlayerBarImpl({ currentTrack, isPlaying, onTogglePlay, onNextTrack, onPrevTrack, isDownloading, loadNonce, playMode, onTogglePlayMode, onExpandNowPlaying }: PlayerBarProps) {
  const { t } = useTranslation();

  // 1. Player state
  const [playerState, dispatch] = useReducer(playerReducer, initialPlayerState);
  const { error: errorInfo, manualResume } = playerState;

  // 2. Shared refs — created once, passed to hooks
  const isPlayingRef = useRef(isPlaying);
  const errorInfoRef = useRef(errorInfo);
  const onNextTrackRef = useRef(onNextTrack);
  const onPrevTrackRef = useRef(onPrevTrack);
  const rateLimitUntilRef = useRef(0);

  const progressBarRef = useRef<HTMLDivElement>(null);
  const progressFillRef = useRef<HTMLDivElement>(null);
  const bufferFillRef = useRef<HTMLDivElement>(null);
  const currentTimeTextRef = useRef<HTMLSpanElement>(null);
  const volumeBarRef = useRef<HTMLDivElement>(null);

  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
  useEffect(() => { errorInfoRef.current = errorInfo; }, [errorInfo]);

  // 3. Shared state
  const [duration, setDuration] = useState(0);
  const [isBuffering, setIsBuffering] = useState(false);

  // 4. Volume state
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isVolumeActive, setIsVolumeActive] = useState(false);
  const volumeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const triggerVolumeActive = useCallback(() => {
    setIsVolumeActive(true);
    if (volumeTimeoutRef.current) clearTimeout(volumeTimeoutRef.current);
    volumeTimeoutRef.current = setTimeout(() => setIsVolumeActive(false), 300);
  }, []);

  // 4. Hooks — ordered by dependency
  // useTrackMetadata uses DOM refs for progress/track restore
  const [coverError, setCoverError] = useState(false);
  const prevTrackIdRef = useRef<string | undefined>(undefined);
  if (currentTrack?.id !== prevTrackIdRef.current) {
    prevTrackIdRef.current = currentTrack?.id;
    if (coverError) setCoverError(false);
  }

  const trackMetadata = useTrackMetadata({
    currentTrack,
    dispatch,
    progressFillRef,
    currentTimeTextRef,
    bufferFillRef,
    setDuration,
  });

  // useErrorDisplay — needs rateLimitUntilRef (audioEngine sets it later)
  const errorDisplay = useErrorDisplay({
    errorInfo,
    dispatch,
    rateLimitUntilRef,
  });

  // useAudioEngine — core audio engine
  const audioEngine = useAudioEngine({
    currentTrack,
    isPlaying,
    playMode,
    loadNonce,
    dispatch,
    t,
    isPlayingRef,
    errorInfoRef,
    onNextTrackRefForEnded: onNextTrackRef,
    manualResume,
    rateLimitUntilRef,
    setDuration,
    setIsBuffering,
  });

  const { audioRefs: { audioRef, audioRef2, activeAudioIndexRef } } = audioEngine;

  // useProgressUI — needs getActiveAudio, audioRef from audioEngine
  const progressUI = useProgressUI({
    getActiveAudio: audioEngine.getActiveAudio,
    currentTrack,
    audioRef,
    progressBarRef,
    progressFillRef,
    currentTimeTextRef,
    volumeBarRef,
    setVolume,
    setIsMuted,
    duration,
  });

  // usePlaybackControl — needs audio engine API
  const playbackControl = usePlaybackControl({
    currentTrack,
    isPlaying,
    onTogglePlay,
    onNextTrack,
    onPrevTrack,
    onNextTrackRef,
    onPrevTrackRef,
    onTogglePlayMode,
    onExpandNowPlaying,
    dispatch,
    t,
    playerState,
    getActiveAudio: audioEngine.getActiveAudio,
    loadNormalAudio: audioEngine.loadNormalAudio,
    performRetry: audioEngine.performRetry,
    audioRef,
    audioRef2,
    activeAudioIndexRef,
    lastKnownPositionRef: audioEngine.lastKnownPositionRef,
    errorPositionRef: audioEngine.errorPositionRef,
    rateLimitUntilRef,
  });

  // useKeyboard — needs audio engine + playback control
  useKeyboard({
    getActiveAudio: audioEngine.getActiveAudio,
    onTogglePlayRef: playbackControl.callbackRefs.onTogglePlayRef,
    onNextTrackRef,
    onPrevTrackRef,
    onTogglePlayModeRef: playbackControl.callbackRefs.onTogglePlayModeRef,
    setVolume,
    setIsMuted,
    setIsVolumeActive: triggerVolumeActive,
  });

  // 5. Volume sync effect
  useEffect(() => {
    for (const el of [audioRef.current, audioRef2.current]) {
      if (el) el.volume = isMuted ? 0 : volume;
    }
  }, [volume, isMuted, currentTrack]);

  // 6. Volume timeout cleanup
  useEffect(() => {
    return () => {
      if (volumeTimeoutRef.current) clearTimeout(volumeTimeoutRef.current);
    };
  }, []);

  const toggleMute = useCallback(() => {
    setIsMuted(prev => !prev);
  }, []);

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
          <div className={`relative w-12 h-12 rounded-md shrink-0 transition-colors flex items-center justify-center overflow-hidden ${currentTrack && (!trackMetadata.coverUrl || coverError) ? 'bg-gradient-to-br from-[#4285F4] to-[#34A853]' : 'bg-gray-200 dark:bg-[#121212]'}`}>
            {trackMetadata.coverUrl && !coverError ? (
              <img src={trackMetadata.coverUrl} alt="Cover" onError={() => setCoverError(true)} className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-110 group-hover:brightness-75" />
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
              {currentTrack ? trackMetadata.realTitle : t('player.no_track')}
            </h4>
            <p className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-2 overflow-hidden whitespace-nowrap text-ellipsis">
              <span className="truncate">{currentTrack ? (trackMetadata.realArtist || t('unknown_artist')) : ""}</span>
            </p>
          </div>
        </div>
        
        {currentTrack && (
          <div className="hidden lg:flex items-center gap-1 shrink-0 ml-2">
            <button 
              onClick={trackMetadata.toggleFavorite}
              className={`transition-all duration-200 hover:scale-110 p-1 ${trackMetadata.isLiked ? 'text-[#4285F4]' : 'text-gray-400 hover:text-gray-900 dark:hover:text-white'}`}
            >
              <Heart className="w-5 h-5" fill={trackMetadata.isLiked ? "currentColor" : "none"} />
            </button>
            <MoreMenu track={currentTrack} isPlayerBarMode={true} />
          </div>
        )}
      </div>

      {/* Center controls */}
      <div className="flex flex-col items-center justify-center flex-1 max-w-[722px] px-2 min-w-[200px]">
        <div className="flex w-full mb-1 items-center justify-center gap-3 sm:gap-6">
          <button 
            onClick={playbackControl.handlePrevClick}
            className="text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#2a2b2f] p-2 rounded-full transition-all active:scale-[0.92] disabled:opacity-50 disabled:hover:bg-transparent shrink-0"
            disabled={!currentTrack}
          >
            <SkipBack className="w-5 h-5" />
          </button>
          
          <button 
            onClick={errorInfo && bannerTypes.includes(errorInfo.type) ? playbackControl.handleRetry : onTogglePlay}
            className={`w-10 h-10 shrink-0 flex items-center justify-center text-white rounded-full transition-all duration-200 shadow-md active:scale-90 ${currentTrack ? 'bg-[#4285F4] hover:bg-blue-600 hover:shadow-lg' : 'bg-gray-400 cursor-not-allowed'}`}
            disabled={!currentTrack || isDownloading}
          >
            {isDownloading || (isBuffering && isPlaying && !errorInfo) ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : errorInfo && bannerTypes.includes(errorInfo.type) ? (
              <RefreshCw className="w-5 h-5" />
            ) : isPlaying ? (
              <Pause className="w-5 h-5" />
            ) : (
              <Play className="w-5 h-5 ml-0.5" />
            )}
          </button>

          <button 
            onClick={() => playbackControl.handleNextClick()}
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
              <div className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-3 h-3 bg-white dark:bg-[#2a2b2f] rotate-45"></div>
            </div>
          </div>
        </div>
        <div className="w-full flex items-center gap-3">
          <span ref={currentTimeTextRef} className="text-xs text-gray-500 min-w-[52px] text-right tabular-nums">0:00</span>
          <div 
            ref={progressBarRef}
            className="flex-1 h-1.5 bg-gray-200 dark:bg-[#2A2A2A] rounded-full cursor-pointer group relative flex items-center"
            onPointerDown={progressUI.handlePointerDown}
          >
            <div 
              ref={bufferFillRef}
              className="absolute left-0 h-full bg-gray-400 dark:bg-gray-500 rounded-full transform-gpu will-change-[width]"
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

      {/* Right Controls */}
      <div className="flex items-center justify-end w-[30%] min-w-[120px] pl-2 gap-3">
        {renderVolumeIcon()}
        <div 
          ref={volumeBarRef}
          className="hidden xl:flex w-16 sm:w-24 h-1.5 bg-gray-200 dark:bg-[#2A2A2A] rounded-full cursor-pointer relative group items-center"
          onPointerDown={progressUI.handleVolumePointerDown}
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
        onTimeUpdate={audioEngine.handleTimeUpdate}
        onProgress={audioEngine.handleTimeUpdate}
        onLoadedMetadata={audioEngine.handleLoadedMetadata}
        onCanPlay={audioEngine.handleCanPlay}
        onWaiting={audioEngine.handleWaiting}
        onPlaying={audioEngine.handlePlaying}
        onError={audioEngine.handleAudioError}
        onEnded={audioEngine.handleEnded}
      />
      <audio
        id="drplay-audio-2"
        ref={audioRef2}
        preload="auto"
        onTimeUpdate={audioEngine.handleTimeUpdate}
        onProgress={audioEngine.handleTimeUpdate}
        onLoadedMetadata={audioEngine.handleLoadedMetadata}
        onCanPlay={audioEngine.handleCanPlay}
        onWaiting={audioEngine.handleWaiting}
        onPlaying={audioEngine.handlePlaying}
        onError={audioEngine.handleAudioError}
        onEnded={audioEngine.handleEnded}
      />

      {/* Error UI Portal */}
      {errorInfo && (toastTypes.includes(errorInfo.type) || bannerTypes.includes(errorInfo.type)) && createPortal(
        bannerTypes.includes(errorInfo.type) ? (
          <div className="absolute top-[76px] left-0 h-11 bg-[#2a2b2f] text-white text-sm flex items-center z-50 select-none">
            <div className="flex items-center gap-3 px-4 flex-1 min-w-0">
              <ErrorIcon type={errorInfo.type} />
              <span className="font-medium truncate">{errorInfo.text}</span>
            </div>
            <div className="w-1.5 self-stretch bg-[#4285F4]" />
          </div>
        ) : (
          <div className={`absolute top-[76px] left-0 h-11 bg-[#2a2b2f] text-white text-sm flex items-center z-50 cursor-pointer select-none transition-transform duration-300 ease-out ${errorDisplay.toastSlideIn ? 'translate-x-0' : '-translate-x-full pointer-events-none'}`} onClick={errorDisplay.dismissToast}>
            <div className="flex items-center gap-3 px-4 flex-1 min-w-0">
              <ErrorIcon type={errorInfo.type} />
              <span className="font-medium truncate">{errorInfo.text}</span>
            </div>
            <div className="w-1.5 self-stretch bg-[#4285F4]" />
          </div>
        ),
        document.getElementById('content-area')!
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
