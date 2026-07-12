let currentPlayPromise: Promise<void> | null = null;
let currentPlayAudio: HTMLAudioElement | null = null;

export async function safePlay(audio: HTMLAudioElement): Promise<void> {
  try {
    currentPlayAudio = audio;
    currentPlayPromise = audio.play();
    await currentPlayPromise;
  } catch (err: any) {
    if (err.name === 'AbortError') {
      return;
    }
    throw err;
  } finally {
    currentPlayPromise = null;
    currentPlayAudio = null;
  }
}

export function safePause(audio: HTMLAudioElement): void {
  if (currentPlayPromise && currentPlayAudio === audio) {
    currentPlayPromise
      .catch(() => {})
      .finally(() => audio.pause());
  } else {
    audio.pause();
  }
}
