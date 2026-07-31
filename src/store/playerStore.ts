import { create } from 'zustand';
import { Track } from '../App';

interface PlayerState {
  currentTrack: Track | null;
  loadNonce: number;
  isPlaying: boolean;
  isDownloading: boolean;
  playMode: 'normal' | 'shuffle' | 'repeat-all' | 'repeat-one';
  originalQueue: Track[];
  playbackQueue: Track[];
  
  setCurrentTrack: (track: Track | null | ((prev: Track | null) => Track | null)) => void;
  triggerReload: () => void;
  setIsPlaying: (isPlaying: boolean | ((prev: boolean) => boolean)) => void;
  setIsDownloading: (isDownloading: boolean) => void;
  setPlayMode: (mode: 'normal' | 'shuffle' | 'repeat-all' | 'repeat-one' | ((prev: 'normal' | 'shuffle' | 'repeat-all' | 'repeat-one') => 'normal' | 'shuffle' | 'repeat-all' | 'repeat-one')) => void;
  setOriginalQueue: (queue: Track[]) => void;
  setPlaybackQueue: (queue: Track[] | ((prev: Track[]) => Track[])) => void;
}

export const usePlayerStore = create<PlayerState>((set) => ({
  currentTrack: null,
  loadNonce: 0,
  isPlaying: false,
  isDownloading: false,
  playMode: 'normal',
  originalQueue: [],
  playbackQueue: [],

  setCurrentTrack: (track) => set((state) => ({ currentTrack: typeof track === 'function' ? track(state.currentTrack) : track })),
  triggerReload: () => set((state) => ({ loadNonce: state.loadNonce + 1 })),
  setIsPlaying: (isPlaying) => set((state) => ({ isPlaying: typeof isPlaying === 'function' ? isPlaying(state.isPlaying) : isPlaying })),
  setIsDownloading: (isDownloading) => set({ isDownloading }),
  setPlayMode: (playMode) => set((state) => ({ playMode: typeof playMode === 'function' ? playMode(state.playMode) : playMode })),
  setOriginalQueue: (originalQueue) => set({ originalQueue }),
  setPlaybackQueue: (queue) => set((state) => ({ playbackQueue: typeof queue === 'function' ? queue(state.playbackQueue) : queue })),
}));
