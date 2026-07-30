import { Track } from '../App';
import { usePlayerStore } from '../store/playerStore';
import { captureError } from '../utils/errorLog';

type AudioEventMap = {
  timeupdate: { currentTime: number; duration: number };
  buffering: { isBuffering: boolean };
  error: { message: string; code: string };
  ended: void;
  play: void;
  pause: void;
};

type AudioEventHandler<K extends keyof AudioEventMap> = (payload: AudioEventMap[K]) => void;

export class AudioController {
  private static instance: AudioController;
  private audio1: HTMLAudioElement;
  private audio2: HTMLAudioElement;
  private activeIndex: 0 | 1 = 0;
  
  private currentTrackId: string | null = null;
  private retryCount = 0;
  private volume = 1;
  private muted = false;
  private listeners: { [K in keyof AudioEventMap]?: AudioEventHandler<K>[] } = {};
  
  private lastTimeUpdate = 0;

  private constructor() {
    this.audio1 = new Audio();
    this.audio2 = new Audio();
    
    // Đảm bảo audio có thể phát qua streaming (Tauri schema `/drive-stream`)
    this.setupAudio(this.audio1);
    this.setupAudio(this.audio2);
  }

  public static getInstance(): AudioController {
    if (!AudioController.instance) {
      AudioController.instance = new AudioController();
    }
    return AudioController.instance;
  }

  private get activeAudio() {
    return this.activeIndex === 0 ? this.audio1 : this.audio2;
  }

  private setupAudio(audio: HTMLAudioElement) {
    audio.addEventListener('timeupdate', () => {
      if (audio !== this.activeAudio) return;
      const now = performance.now();
      if (now - this.lastTimeUpdate > 200) { 
        this.lastTimeUpdate = now;
        this.emit('timeupdate', { currentTime: audio.currentTime, duration: audio.duration || 0 });
      }
    });

    audio.addEventListener('waiting', () => {
      if (audio === this.activeAudio) {
        this.emit('buffering', { isBuffering: true });
      }
    });

    audio.addEventListener('playing', () => {
      if (audio === this.activeAudio) {
        this.emit('buffering', { isBuffering: false });
        this.emit('play', undefined as void);
        usePlayerStore.getState().setIsPlaying(true);
      }
    });

    audio.addEventListener('pause', () => {
      if (audio === this.activeAudio) {
        this.emit('pause', undefined as void);
        usePlayerStore.getState().setIsPlaying(false);
      }
    });

    audio.addEventListener('ended', () => {
      if (audio === this.activeAudio) {
        if (audio.duration && audio.currentTime < audio.duration - 1) return;
        this.emit('ended', undefined as void);
      }
    });

    audio.addEventListener('error', () => {
      if (audio !== this.activeAudio) return;
      this.retryCount++;
      captureError({ level: 'error', source: 'AudioController', message: `Audio error (attempt ${this.retryCount})` });
      
      if (this.retryCount < 3 && this.currentTrackId) {
        this.emit('error', { message: 'Mạng không ổn định, đang thử lại...', code: 'network_interrupted' });
        const pos = audio.currentTime;
        setTimeout(() => this.retry(pos), 2000);
      } else {
        this.emit('error', { message: 'File lỗi định dạng, đang bỏ qua...', code: 'format_error' });
        this.emit('ended', undefined as void); 
      }
    });
  }

  public on<K extends keyof AudioEventMap>(event: K, handler: AudioEventHandler<K>) {
    if (!this.listeners[event]) (this.listeners[event] as any) = [];
    (this.listeners[event] as any).push(handler);
    return () => {
      (this.listeners[event] as any) = (this.listeners[event] as any).filter((h: any) => h !== handler);
    };
  }

  private emit<K extends keyof AudioEventMap>(event: K, payload: AudioEventMap[K]) {
    const handlers = this.listeners[event] as AudioEventHandler<K>[] | undefined;
    if (handlers) {
      handlers.forEach(h => h(payload));
    }
  }

  public async playTrack(track: Track, startTime?: number) {
    if (this.currentTrackId === track.id) {
      if (this.activeAudio.paused) {
        this.activeAudio.play().catch(e => console.warn(e));
      }
      return;
    }

    this.currentTrackId = track.id;
    this.retryCount = 0;
    
    const oldAudio = this.activeAudio;
    oldAudio.pause();
    oldAudio.removeAttribute('src');

    this.activeIndex = this.activeIndex === 0 ? 1 : 0;
    const newAudio = this.activeAudio;
    
    const url = track.streamUrl || `/drive-stream/${track.id}`;
    newAudio.src = url;
    newAudio.volume = this.muted ? 0 : this.volume;
    newAudio.load();

    if (startTime !== undefined) {
      const handleMetadata = () => {
        newAudio.currentTime = startTime;
        newAudio.removeEventListener('loadedmetadata', handleMetadata);
      };
      newAudio.addEventListener('loadedmetadata', handleMetadata);
    }

    try {
      await newAudio.play();
    } catch (e: any) {
      console.warn("Autoplay prevented or stream error", e);
      // Prevent resetting isPlaying if the user already clicked another track (interruption)
      if (e.name !== 'AbortError' && this.currentTrackId === track.id) {
        usePlayerStore.getState().setIsPlaying(false);
      }
    }
  }

  private async retry(position: number) {
    if (!this.currentTrackId) return;
    const audio = this.activeAudio;
    const src = audio.src;
    audio.pause();
    audio.removeAttribute('src');
    
    // Strip old query params and add new retry param
    const baseUrl = src.split('?')[0];
    audio.src = baseUrl + '?retry=' + Date.now();
    audio.load();
    
    const handleMetadata = () => {
      audio.currentTime = position;
      audio.removeEventListener('loadedmetadata', handleMetadata);
    };
    audio.addEventListener('loadedmetadata', handleMetadata);

    try {
      await audio.play();
    } catch (e: any) {
      console.warn("Retry autoplay failed", e);
      if (e.name !== 'AbortError') {
        // Only warn for real errors, AbortError is normal during fast switching
      }
    }
  }

  public togglePlay() {
    if (!this.currentTrackId) return;
    if (this.activeAudio.paused) {
      this.activeAudio.play().catch(e => console.warn(e));
    } else {
      this.activeAudio.pause();
    }
  }

  public pause() {
    this.activeAudio.pause();
  }

  public seek(time: number) {
    if (this.activeAudio.readyState > 0) {
      this.activeAudio.currentTime = time;
    }
  }

  public setVolume(vol: number) {
    this.volume = Math.max(0, Math.min(1, vol));
    if (!this.muted) {
      this.audio1.volume = this.volume;
      this.audio2.volume = this.volume;
    }
  }

  public toggleMute() {
    this.muted = !this.muted;
    this.audio1.volume = this.muted ? 0 : this.volume;
    this.audio2.volume = this.muted ? 0 : this.volume;
    return this.muted;
  }

  public getVolume() { return this.volume; }
  public isMuted() { return this.muted; }
  public getCurrentTime() { return this.activeAudio.currentTime; }
  public getDuration() { return this.activeAudio.duration || 0; }
  
  // Expose prefetch for gapless if needed
  public preloadTrack(url: string) {
    const inactiveAudio = this.activeIndex === 0 ? this.audio2 : this.audio1;
    inactiveAudio.src = url;
    inactiveAudio.load();
  }
}
