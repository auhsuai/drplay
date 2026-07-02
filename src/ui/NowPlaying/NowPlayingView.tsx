import { useState, useEffect, useRef } from "react";
import { Track } from "../../App";
import { Music, ChevronDown, Play, Pause, SkipBack, SkipForward, Repeat, Repeat1, Shuffle } from "lucide-react";
import { getTrackMetadata } from "../../utils/metadata";
import { getPalette } from '../../utils/color';
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";

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
}

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

export function NowPlayingView({ 
  currentTrack, 
  isPlaying, 
  onTogglePlay, 
  onNextTrack, 
  onPrevTrack, 
  playMode, 
  onTogglePlayMode,
  onBack,
  isOpen
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
  const progressBarRef = useRef<HTMLDivElement>(null);
  const progressFillRef = useRef<HTMLDivElement>(null);
  const bufferFillRef = useRef<HTMLDivElement>(null);
  const currentTimeTextRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
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

      getTrackMetadata(currentTrack.id, currentTrack.streamUrl || undefined)
        .then(metadata => {
          if (isCancelled) return;
          if (metadata.title) setRealTitle(metadata.title);
          if (metadata.artist) setRealArtist(metadata.artist);
          
          const targetCoverUrl = metadata.fullCoverUrl || metadata.coverUrl;
          if (targetCoverUrl) {
            setCoverUrl(targetCoverUrl);
            getPalette(metadata.coverUrl || targetCoverUrl)
              .then(colors => {
                if (isCancelled) return;
                setBgColor(colors[0]);
                setBgPalette(colors);
              })
              .catch(() => {
                if (!isCancelled) {
                  setBgColor('');
                  setBgPalette([]);
                }
              });
          } else if (metadata.pictureData && metadata.pictureFormat) {
            const blob = new Blob([new Uint8Array(metadata.pictureData)], { type: metadata.pictureFormat });
            objectUrl = URL.createObjectURL(blob);
            setCoverUrl(objectUrl);
            
            getPalette(objectUrl)
              .then(colors => {
                if (isCancelled) return;
                setBgColor(colors[0]);
                setBgPalette(colors);
              })
              .catch(() => {
                if (!isCancelled) {
                  setBgColor('');
                  setBgPalette([]);
                }
              });
          } else {
            setBgColor('');
            setBgPalette([]);
          }
        })
        .catch((e) => {
          console.error(e);
          if (!isCancelled) {
            setBgColor('');
            setBgPalette([]);
          }
        });
        
      return () => {
        isCancelled = true;
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
  
  useEffect(() => {
    if (!isOpen) return;
    let lastTimeText = "";
    let lastProgressWidth = "";
    const audio = document.getElementById('drplay-audio') as HTMLAudioElement;
    
    const updateProgressUI = () => {
      if (audio && !isDragging && progressFillRef.current && currentTimeTextRef.current) {
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
  }, [isOpen, isDragging, duration, currentTrack]);

  // Bulletproof Interval to update buffer percent
  useEffect(() => {
    if (!isOpen) return;
    const interval = setInterval(async () => {
      let newBufferedPercent = 0;
      try {
        const [basePos, dataLen, totalLen] = await invoke<[number, number, number | null]>("get_proxy_cache_status");
        if (totalLen && totalLen > 0) {
          const maxBufferedPos = basePos + dataLen;
          newBufferedPercent = Math.min(100, (maxBufferedPos / totalLen) * 100);
        } else {
          const audio = document.getElementById('drplay-audio') as HTMLAudioElement;
          if (audio) {
            const buffered = audio.buffered;
            const currentDuration = audio.duration || duration;
            if (currentDuration > 0 && buffered.length > 0) {
              const furthestBuffer = buffered.end(buffered.length - 1);
              newBufferedPercent = Math.min(100, (furthestBuffer / currentDuration) * 100);
            }
          }
        }
      } catch (e) {
        const audio = document.getElementById('drplay-audio') as HTMLAudioElement;
        if (audio) {
          const buffered = audio.buffered;
          const currentDuration = audio.duration || duration;
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
  }, [isOpen, duration]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!progressBarRef.current) return;
    setIsDragging(true);
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
    
    const onPointerUp = (upEvent: PointerEvent) => {
      setIsDragging(false);
      const finalTime = updateTimeUI(upEvent.clientX);
      const audio = document.getElementById('drplay-audio') as HTMLAudioElement;
      if (audio) {
        audio.currentTime = finalTime;
      }
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
    
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  if (!currentTrack) {
    return (
      <main className="flex-1 bg-gray-100 dark:bg-[#121212] overflow-hidden flex flex-col items-center justify-center transition-colors duration-300 relative">
        <button onClick={onBack} className="absolute top-8 left-8 p-2 text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors active:scale-95 z-50">
          <ChevronDown className="w-6 h-6" />
        </button>
        <Music className="w-24 h-24 text-gray-300 dark:text-gray-700 mb-6" />
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

      <div className="relative z-10 w-full h-full flex flex-col items-center justify-between p-6 md:p-12 animate-in fade-in zoom-in-95 duration-500 overflow-y-auto">
        {/* Cover Art Container */}
        <div className="flex-1 w-full flex items-center justify-center min-h-[40vh] mt-4 md:mt-8">
          <div className={`w-64 h-64 md:w-80 md:h-80 lg:w-[480px] lg:h-[480px] xl:w-[560px] xl:h-[560px] aspect-square rounded-2xl shadow-[0_12px_30px_rgba(0,0,0,0.15)] dark:shadow-[0_20px_40px_rgba(0,0,0,0.4)] overflow-hidden shrink-0 transition-all duration-700 ${!coverUrl ? 'bg-gradient-to-br from-[#4285F4]/10 to-[#34A853]/10 flex items-center justify-center relative' : 'bg-gray-100 dark:bg-[#202124]'}`}>
          {coverUrl ? (
            <img src={coverUrl} alt="Cover" className="w-full h-full object-cover" />
          ) : (
            <>
              <Music className="w-20 h-20 text-[#4285F4]/40 drop-shadow-sm" />
            </>
          )}
          </div>
        </div>
        
        <div className="w-full max-w-4xl px-4 shrink-0 pb-8 pt-12">
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
            
            <div className="w-full flex items-center gap-3">
              <span ref={currentTimeTextRef} className="text-xs text-gray-500 w-10 text-right">0:00</span>
              <div 
                ref={progressBarRef}
                className="flex-1 h-1.5 bg-gray-200 dark:bg-[#2A2A2A] rounded-full cursor-pointer group relative flex items-center"
                onPointerDown={handlePointerDown}
              >
                <div 
                  ref={bufferFillRef}
                  className="absolute left-0 h-full bg-gray-400 dark:bg-gray-500 rounded-full transition-all duration-300 pointer-events-none transform-gpu will-change-[width]"
                ></div>
                
                <div 
                  ref={progressFillRef}
                  className={`absolute left-0 h-full bg-[#4285F4] rounded-full flex items-center transform-gpu will-change-[width] ${isDragging ? '' : 'transition-all duration-150'}`}
                >
                  <div className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 w-3 h-3 bg-white rounded-full shadow shrink-0"></div>
                </div>
              </div>
              <span className="text-xs text-gray-500 w-10">{formatTime(duration)}</span>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
