let currentPlayPromise: Promise<void> | null = null;

export async function safePlay(audio: HTMLAudioElement): Promise<void> {
  try {
    currentPlayPromise = audio.play();
    await currentPlayPromise;
  } catch (err: any) {
    // AbortError occurs when pause() or load() is called while play() Promise is pending
    // This is a valid race condition between sequential commands, not an actual error.
    if (err.name === 'AbortError') {
      console.debug('[Audio] play() was validly interrupted by a subsequent pause() or load()');
      return;
    }
    throw err;
  } finally {
    currentPlayPromise = null;
  }
}

export function safePause(audio: HTMLAudioElement): void {
  if (currentPlayPromise) {
    currentPlayPromise
      .catch(() => {})
      .finally(() => audio.pause());
  } else {
    audio.pause();
  }
}
