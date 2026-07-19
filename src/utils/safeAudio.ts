let currentPlayPromise: Promise<void> | null = null;
let currentPlayAudio: HTMLAudioElement | null = null;

export async function safePlay(audio: HTMLAudioElement): Promise<void> {
  // Capture this call's own promise + element in locals. When tracks are
  // switched quickly, a newer safePlay() may have already overwritten the
  // module-level globals before this older call resolves. The `finally` block
  // below must only clear the globals if they STILL refer to this call — else
  // it would clobber the newer track's in-flight state and a later
  // safePause(newAudio) would fall into its direct-pause branch, producing a
  // spurious auto-stop (the fast-switch bug).
  const myPromise = audio.play();
  currentPlayAudio = audio;
  currentPlayPromise = myPromise;

  try {
    await myPromise;
  } catch (err: any) {
    if (err && err.name === 'AbortError') {
      return;
    }
    throw err;
  } finally {
    if (currentPlayAudio === audio) {
      currentPlayAudio = null;
    }
    if (currentPlayPromise === myPromise) {
      currentPlayPromise = null;
    }
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
