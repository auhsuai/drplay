import { Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Repeat1, Heart, ChevronDown, Music } from 'lucide-react'
import { Track } from '../../App'
import { formatTime } from '../../utils/formatTime'

interface FullPlayerProps {
  currentTrack: Track | null
  isPlaying: boolean
  position: number
  duration: number
  isLiked: boolean
  playMode: string
  onTogglePlay: () => void
  onNextTrack: () => void
  onPrevTrack: () => void
  onTogglePlayMode: () => void
  onToggleFavorite: () => void
  onSeek: (time: number) => void
  onMinimize: () => void
}

export function FullPlayer({
  currentTrack, isPlaying, position, duration, isLiked, playMode,
  onTogglePlay, onNextTrack, onPrevTrack, onTogglePlayMode,
  onToggleFavorite, onSeek, onMinimize
}: FullPlayerProps) {
  const progressPercent = duration > 0 ? (position / duration) * 100 : 0

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (duration <= 0) return
    const bounds = e.currentTarget.getBoundingClientRect()
    const percent = Math.max(0, Math.min(1, (e.clientX - bounds.left) / bounds.width))
    onSeek(percent * duration)
  }

  return (
    <div className="fixed inset-0 bg-white dark:bg-[#121212] z-50 flex flex-col">
      <div className="flex items-center justify-between p-4 shrink-0">
        <button onClick={onMinimize} className="text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white p-2 rounded-full hover:bg-gray-100 dark:hover:bg-[#2a2b2f] transition-colors">
          <ChevronDown className="w-6 h-6" />
        </button>
        <span className="text-xs text-gray-500 font-medium">Now Playing</span>
        <div className="w-10" />
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-8 min-h-0">
        <div className="w-56 h-56 sm:w-72 sm:h-72 bg-gray-200 dark:bg-[#202124] rounded-2xl flex items-center justify-center shadow-2xl mb-6">
          {currentTrack ? (
            <Music className="w-16 h-16 text-gray-400" />
          ) : (
            <Music className="w-16 h-16 text-gray-500" />
          )}
        </div>

        <h2 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white text-center truncate max-w-full px-4">
          {currentTrack?.title || 'No track'}
        </h2>
        <p className="text-sm text-gray-500 mt-1">
          {currentTrack?.artist || ''}
        </p>
      </div>

      <div className="px-6 sm:px-10 pb-4 shrink-0">
        <div
          className="w-full h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full cursor-pointer relative group"
          onClick={handleProgressClick}
        >
          <div className="h-full bg-[#4285F4] rounded-full relative" style={{ width: `${progressPercent}%` }}>
            <div className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 w-3 h-3 bg-white rounded-full shadow opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        </div>
        <div className="flex justify-between mt-1.5">
          <span className="text-xs text-gray-500 tabular-nums">{formatTime(position)}</span>
          <span className="text-xs text-gray-500 tabular-nums">{formatTime(duration)}</span>
        </div>
      </div>

      <div className="flex items-center justify-center gap-4 sm:gap-6 pb-6 sm:pb-10 shrink-0">
        <button onClick={onTogglePlayMode} className={`p-2 rounded-full transition-colors ${playMode !== 'normal' ? 'text-[#4285F4]' : 'text-gray-500 hover:text-gray-900 dark:hover:text-white'}`}>
          {playMode === 'shuffle' ? <Shuffle className="w-5 h-5" /> : playMode === 'repeat-one' ? <Repeat1 className="w-5 h-5" /> : <Repeat className="w-5 h-5" />}
        </button>
        <button onClick={onPrevTrack} className="text-gray-500 hover:text-gray-900 dark:hover:text-white p-2 rounded-full hover:bg-gray-100 dark:hover:bg-[#2a2b2f] transition-colors">
          <SkipBack className="w-7 h-7" />
        </button>
        <button onClick={onTogglePlay} className="bg-[#4285F4] text-white w-14 h-14 sm:w-16 sm:h-16 rounded-full flex items-center justify-center hover:bg-blue-600 transition-colors shadow-lg active:scale-95">
          {isPlaying ? <Pause className="w-7 h-7" /> : <Play className="w-7 h-7 ml-0.5" />}
        </button>
        <button onClick={onNextTrack} className="text-gray-500 hover:text-gray-900 dark:hover:text-white p-2 rounded-full hover:bg-gray-100 dark:hover:bg-[#2a2b2f] transition-colors">
          <SkipForward className="w-7 h-7" />
        </button>
        <button onClick={onToggleFavorite} className={`p-2 rounded-full transition-colors ${isLiked ? 'text-[#4285F4]' : 'text-gray-500 hover:text-gray-900 dark:hover:text-white'}`}>
          <Heart className="w-5 h-5" fill={isLiked ? 'currentColor' : 'none'} />
        </button>
      </div>
    </div>
  )
}
