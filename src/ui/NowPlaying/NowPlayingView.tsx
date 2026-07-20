import { memo, useState, useEffect, useRef } from "react";
import { Track } from "../../App";
import { formatTime } from "../../utils/formatTime";
import { Music, ChevronDown, Play, Pause, SkipBack, SkipForward, Repeat, Repeat1, Shuffle } from "lucide-react";
import { getTrackMetadata } from "../../utils/metadata";
import { getPalette } from '../../utils/color';
import { useTranslation } from "react-i18next";
import { listen } from '@tauri-apps/api/event';

function classifyNowPlayingError(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: "UnknownError", message: String(err) };
}

interface NowPlayingViewProps {
  currentTrack: Track | null;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onNextTrack: () => void;
  onPrevTrack: () => void;
  playMode: 'normal' | 'shuffle' | 'repeat-all' | 'repeat-one';
  onTogglePlayMode: () => void;
  onBack: () => void;
  isOpen: boolean;
  token: string | null;
}


export const NowPlayingView = memo(function NowPlayingView({ 
  currentTrack, 
  isPlaying, 
  onTogglePlay, 
  onNextTrack, 
  onPrevTrack, 
  playMode, 
  onTogglePlayMode,
  onBack,
  isOpen,
  token
}: NowPlayingViewProps) {
  const { t } = useTranslation();
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [realTitle, setRealTitle] = useState("");
  const [realArtist, setRealArtist] = useState("");
  const [bgColor, setBgColor] = useState<string>('');
  const [bgPalette, setBgPalette] = useState<string[]>([]);
  
  // Progress state
  const [duration, setDuration] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const progressFillRef = useRef<HTMLDivElement>(null);
  const bufferFillRef = useRef<HTMLDivElement>(null);
  const currentTimeTextRef = useRef<HTMLSpanElement>(null);
  const lastValidBufferPercentRef = useRef(0);

  useEffect(() => {
    lastValidBufferPercentRef.current = 0;
    if (currentTrack) {
      setRealTitle(currentTrack.title);
      setRealArtist(currentTrack.artist || "");
      setCoverUrl(null);
      
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
      
      let isCancelled = false;
      let objectUrl: string | null = null;
      const controller = new AbortController();

      getTrackMetadata(currentTrack.id, token || undefined, currentTrack.size, currentTrack.originalName, controller.signal)
        .then(metadata => {
          if (isCancelled) return;
          if (metadata.title) setRealTitle(metadata.title);
          if (metadata.artist) setRealArtist(metadata.artist);
          
          const targetCover = metadata.fullCoverUrl || metadata.coverUrl;
          if (targetCover) {
            setCoverUrl(targetCover);
              getPalette(targetCover)
                .then(colors => {
                  if (isCancelled) return;
                  setBgColor(colors[0]);
                  setBgPalette(colors);
                })
                .catch((err) => {
                  if (!isCancelled) {
                    setBgColor('');
                    setBgPalette([]);
                  }
                  console.warn('[NowPlaying] palette-failed', { trackId: currentTrack?.id, err: classifyNowPlayingError(err) });
                });
          } else if ((metadata.pictureDataFull || metadata.pictureData) && metadata.pictureFormat) {
            const data = metadata.pictureDataFull || metadata.pictureData;
            const blob = new Blob([new Uint8Array(data!)], { type: metadata.pictureFormat });
            objectUrl = URL.createObjectURL(blob);
            setCoverUrl(objectUrl);
            
              getPalette(objectUrl)
                .then(colors => {
                  if (isCancelled) return;
                  setBgColor(colors[0]);
                  setBgPalette(colors);
                })
                .catch((err) => {
                  if (!isCancelled) {
                    setBgColor('');
                    setBgPalette([]);
                  }
                  console.warn('[NowPlaying] palette-failed', { trackId: currentTrack?.id, err: classifyNowPlayingError(err) });
                });
          } else {
            setBgColor('');
            setBgPalette([]);
          }
        })
        .catch((e) => {
          console.error('[NowPlaying] track-metadata-failed', { trackId: currentTrack?.id, ...classifyNowPlayingError(e) });
          if (!isCancelled) {
            setBgColor('');
            setBgPalette([]);
          }
        });
        
      return () => {
        isCancelled = true;
        controller.abort();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        setBgColor('');
        setBgPalette([]);
      };
    } else {
      setBgColor('');
      setBgPalette([]);
    }
  }, [currentTrack?.id, currentTrack?.streamUrl]);

  // Sync with audio element
  useEffect(() => {
    const audio = document.getElementById('drplay-audio') as HTMLAudioElement;
    if (!audio) return;

    const updateDuration = () => setDuration(audio.duration || 0);

    audio.addEventListener('durationchange', updateDuration);
    audio.addEventListener('loadedmetadata', updateDuration);

    setDuration(audio.duration || 0);

    return () => {
      audio.removeEventListener('durationchange', updateDuration);
      audio.removeEventListener('loadedmetadata', updateDuration);
    };
  }, [currentTrack]);

  const tauriBufferEndRef = useRef<number | null>(null);
  
  useEffect(() => {
    tauriBufferEndRef.current = null;
    let bufferFn: (() => void) | null = null;
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
          // NOTE: do NOT write to bufferFillRef here. The buffer bar is now
          // driven by the actual HTMLAudioElement.buffered TimeRanges in
          // updateProgressUI (called on every `timeupdate` event). See the
          // comment there for why the proxy's byte-ratio is inaccurate.
        }
      }
    }).then(fn => {
      if (bufferCancelled) { fn(); return; }
      bufferFn = fn;
    });

    return () => {
      bufferCancelled = true;
      bufferFn?.();
    };
  }, [currentTrack?.id]);
  
  useEffect(() => {
    if (!isOpen) return;
    let lastTimeText = "";
    let lastProgressWidth = "";
    const audio = document.getElementById('drplay-audio') as HTMLAudioElement;
    
    const updateProgressUI = () => {
      if (audio && !isDraggingRef.current && progressFillRef.current && currentTimeTextRef.current) {
        const time = audio.currentTime;

        // Prevent UI jump to 0:00 when waiting for track to restore (sync with PlayerBar)
        if (currentTrack && currentTrack.restoreTime !== undefined && time === 0 && currentTrack.restoreTime > 1) {
          return;
        }

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
          // Buffer bar is driven by the actual browser-buffered range, not the
          // proxy's byte accounting. The proxy's buffer-status event reports
          // prefetch progress in bytes which diverges from real playback time
          // for VBR audio and reports 100% once its slice cache can serve a
          // range even if the browser has only buffered a few seconds.
          if (bufferFillRef.current && dur > 0 && audio.buffered.length > 0) {
            const bufferedEnd = audio.buffered.end(audio.buffered.length - 1);
            const pct = Math.min(100, (bufferedEnd / dur) * 100);
            bufferFillRef.current.style.left = '0%';
            bufferFillRef.current.style.width = `${pct}%`;
          }
        }
      }
    };

    if (audio) {
      audio.addEventListener('timeupdate', updateProgressUI);
      updateProgressUI();
      
      return () => {
        audio.removeEventListener('timeupdate', updateProgressUI);
      };
    }
  }, [isOpen, duration, currentTrack]);

  // (Buffer logic is now handled by listen('buffer-status') and updateProgressUI)

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!progressBarRef.current) return;
    setIsDragging(true);
    isDraggingRef.current = true;
      try { progressBarRef.current.setPointerCapture(e.pointerId); } catch (err) { console.warn('[NowPlaying] setPointerCapture failed', { pointerId: e.pointerId, trackId: currentTrack?.id, err }); }
    const bounds = progressBarRef.current.getBoundingClientRect();
    
    const updateTimeUI = (clientX: number) => {
      const percent = Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width));
      const newTime = percent * duration;
      if (progressFillRef.current) progressFillRef.current.style.width = `${percent * 100}%`;
      if (currentTimeTextRef.current) currentTimeTextRef.current.textContent = formatTime(newTime);
      return newTime;
    };
    
    updateTimeUI(e.clientX);
    
    const onPointerMove = (moveEvent: PointerEvent) => {
      updateTimeUI(moveEvent.clientX);
    };
    
    const commit = (clientX: number) => {
      setIsDragging(false);
      isDraggingRef.current = false;
      const finalTime = updateTimeUI(clientX);
      const audio = document.getElementById('drplay-audio') as HTMLAudioElement;
      if (audio) {
        audio.currentTime = finalTime;
      }
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
    };

    const onPointerUp = (upEvent: PointerEvent) => {
      commit(upEvent.clientX);
    };

    const onPointerCancel = (cancelEvent: PointerEvent) => {
      commit(cancelEvent.clientX);
    };
    
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
  };

  if (!currentTrack) {
    return (
      <main className="flex-1 bg-gray-100 dark:bg-[#121212] overflow-hidden flex flex-col items-center justify-center transition-colors duration-300 relative">
        <button onClick={onBack} className="absolute top-8 left-8 p-2 text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors active:scale-95 z-50">
          <ChevronDown className="w-6 h-6" />
        </button>
        <div className="w-48 h-48 rounded-2xl bg-gradient-to-br from-[#4285F4]/10 to-[#34A853]/10 flex items-center justify-center mb-6">
          <Music className="w-24 h-24 text-[#4285F4]/40 dark:text-[#34A853]/50 drop-shadow-sm" />
        </div>
        <h2 className="text-xl font-bold text-gray-500 dark:text-gray-400">{t('player.no_track', 'Chưa có bài hát nào')}</h2>
      </main>
    );
  }


  return (
    <main 
      className="h-full overflow-hidden flex flex-col relative transition-all duration-1000 ease-in-out"
      style={bgPalette.length === 4 ? {
        background: `
          linear-gradient(to bottom, transparent 65%, var(--player-bg-fade) 100%),
          radial-gradient(circle at 0% 0%, ${bgPalette[0]} 0%, transparent 75%),
          radial-gradient(circle at 100% 0%, ${bgPalette[1]} 0%, transparent 75%),
          radial-gradient(circle at 0% 100%, ${bgPalette[2]} 0%, transparent 75%),
          radial-gradient(circle at 100% 100%, ${bgPalette[3]} 0%, transparent 75%),
          var(--player-bg-solid)
        `
      } : {
        background: bgColor ? `linear-gradient(to bottom, ${bgColor} 0%, var(--player-bg-solid) 100%)` : 'var(--player-bg-solid)'
      }}
    >
      {/* Back Button */}
      <div className="absolute top-6 left-6 z-50">
        <button 
          onClick={onBack} 
          className="p-2 text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors active:scale-95"
        >
          <ChevronDown className="w-6 h-6" />
        </button>
      </div>

      <div className="relative z-10 w-full h-full flex flex-col items-center justify-center p-6 md:p-12 animate-in fade-in zoom-in-95 duration-500 overflow-y-auto">
        {/* Content group: centered vertically when room, scrolls when not */}
        <div className="w-full flex flex-col items-center pt-24 md:pt-28 pb-24 md:pb-28">
        {/* Cover Art Container */}
        <div className="w-full flex items-center justify-center mt-4 md:mt-8">
          <div className={`w-[min(16rem,60vh)] md:w-[min(20rem,60vh)] lg:w-[min(480px,60vh)] xl:w-[min(560px,60vh)] max-w-full aspect-square h-auto max-h-[min(560px,60vh)] rounded-2xl shadow-[0_12px_30px_rgba(0,0,0,0.15)] dark:shadow-[0_20px_40px_rgba(0,0,0,0.4)] overflow-hidden transition-all duration-700 ${!coverUrl ? 'bg-gradient-to-br from-[#4285F4]/10 to-[#34A853]/10 flex items-center justify-center relative' : 'bg-gray-100 dark:bg-[#202124]'}`}>
          {coverUrl ? (
            <img 
              src={coverUrl} 
              alt="Cover" 
              className="w-full h-full object-cover" 
              onError={() => setCoverUrl(null)}
            />
          ) : (
            <>
              <Music className="w-20 h-20 text-[#4285F4]/40 drop-shadow-sm" />
            </>
          )}
          </div>
        </div>
        
        <div className="w-full max-w-4xl px-4 shrink-0 mt-6 md:mt-8 pb-8">
          {/* Info */}
          <div className="text-center mb-8">
            <h1 className="text-2xl md:text-3xl font-bold text-gray-900 dark:text-white mb-2 truncate tracking-tight">
              {realTitle}
            </h1>
            <p className="text-base md:text-lg font-medium text-gray-500 dark:text-gray-400 truncate">
              {realArtist || t('unknown_artist')}
            </p>
          </div>

          {/* PlayerBar Clone Controls */}
          <div className="w-full flex flex-col items-center justify-center max-w-[800px] mx-auto">
            <div className="w-full flex items-center justify-center mb-4">
              {/* Left spacer for perfect centering */}
              <div className="flex-1 flex justify-end"></div>
              
              <div className="flex items-center gap-6 px-6">
                <button 
                  onClick={onPrevTrack}
                  className="text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#2a2b2f] p-2 rounded-full transition-all active:scale-[0.92]"
                >
                  <SkipBack className="w-5 h-5" />
                </button>
                
                <button 
                  onClick={onTogglePlay}
                  className="w-10 h-10 flex items-center justify-center text-white bg-[#4285F4] hover:bg-blue-600 hover:shadow-lg rounded-full transition-all duration-200 shadow-md active:scale-90"
                >
                  {isPlaying ? (
                    <Pause className="w-5 h-5" />
                  ) : (
                    <Play className="w-5 h-5 ml-0.5" />
                  )}
                </button>

                <button 
                  onClick={onNextTrack}
                  className="text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#2a2b2f] p-2 rounded-full transition-all active:scale-[0.92]"
                >
                  <SkipForward className="w-5 h-5" />
                </button>
              </div>
              
              {/* Right side controls */}
              <div className="flex-1 flex justify-start">
                <div className="relative group flex items-center">
                  <button 
                    onClick={onTogglePlayMode}
                    className={`p-2 rounded-full transition-all active:scale-[0.92] ${playMode !== 'normal' ? 'text-[#4285F4] hover:bg-[#4285F4]/10' : 'text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#2a2b2f]'}`}
                  >
                    {playMode === 'shuffle' && <Shuffle className="w-5 h-5" />}
                    {playMode === 'repeat-all' && <Repeat className="w-5 h-5" />}
                    {playMode === 'repeat-one' && <Repeat1 className="w-5 h-5" />}
                    {playMode === 'normal' && <Repeat className="w-5 h-5 opacity-40" />}
                  </button>
                </div>
              </div>
            </div>
            
            <div className="w-full flex items-center gap-3 mb-2">
              <span ref={currentTimeTextRef} className="text-xs text-gray-500 min-w-[52px] text-right tabular-nums">0:00</span>
              <div 
                ref={progressBarRef}
                className="flex-1 h-1.5 bg-gray-200 dark:bg-[#2A2A2A] rounded-full cursor-pointer group relative flex items-center"
                onPointerDown={handlePointerDown}
              >
                <div 
                  ref={bufferFillRef}
                  className="absolute left-0 h-full bg-gray-400 dark:bg-gray-500 rounded-full pointer-events-none transform-gpu will-change-[width]"
                ></div>
                
                <div 
                  ref={progressFillRef}
                  className={`absolute left-0 h-full bg-[#4285F4] rounded-full flex items-center transform-gpu will-change-[width] ${isDragging ? '' : 'transition-all duration-150'}`}
                >
                  <div className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 w-3 h-3 bg-white rounded-full shadow shrink-0"></div>
                </div>
              </div>
              <span className="text-xs text-gray-500 min-w-[52px] tabular-nums">{formatTime(duration)}</span>
            </div>
          </div>
        </div>
        </div>
      </div>
    </main>
  );
});
