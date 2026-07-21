// This app streams files directly from Google Drive with no local tag/cover
// database (the previous R2-cover + SQLite-tag pipeline was removed). "Track
// metadata" here is therefore purely derived from what Google Drive already
// gives us for free: the file name. There is no cover art and no real
// title/artist/album tagging — every consumer of `getTrackMetadata` gets a
// title derived from the filename and an "Unknown Artist" placeholder.

const META_MODULE = "metadata";

export interface CachedMetadata {
  title: string;
  artist: string;
  duration: number;
  durationEstimated: boolean;
  size?: number;
}

// Small in-memory cache so repeated lookups for the same fileId (e.g. re-render
// of a virtualized list) return a referentially-stable object instead of
// allocating a new one every time.
export const metadataCache: Record<string, CachedMetadata> = {};

function deriveTitle(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

function classifyMetaError(err: unknown): { name: string; message: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return { name: "UnknownError", message: String(err) };
}

/**
 * Derive display metadata for a Drive file. Purely synchronous/local — no
 * network call, no Tauri IPC, no database lookup. Kept as an async function
 * so existing call sites (which `await`/`.then()` it) don't need to change.
 */
export async function getTrackMetadata(
  fileId: string,
  _token?: string,
  size?: number,
  name?: string,
  _signal?: AbortSignal,
  _forceNetwork: boolean = false,
): Promise<CachedMetadata> {
  const cached = metadataCache[fileId];
  if (cached) return cached;

  const entry: CachedMetadata = {
    title: deriveTitle(name ?? "audio.mp3"),
    artist: "Unknown Artist",
    duration: 0,
    durationEstimated: true,
    size,
  };
  metadataCache[fileId] = entry;
  return entry;
}

export function cacheTrackMetadata(fileId: string, entry: CachedMetadata): CachedMetadata {
  metadataCache[fileId] = entry;
  return entry;
}

export function clearAllMetadataCache(): void {
  for (const k of Object.keys(metadataCache)) delete metadataCache[k];
}

/**
 * Record the real duration once the <audio> element has measured it during
 * playback. There is no backing database anymore, so this only updates the
 * in-memory cache (used for e.g. session-restore display) and notifies
 * listeners — it does not persist anywhere.
 */
export async function updateTrackDuration(fileId: string, accurateDuration: number): Promise<void> {
  const existing = metadataCache[fileId];
  if (existing) {
    existing.duration = accurateDuration;
    existing.durationEstimated = false;
  }
  try {
    window.dispatchEvent(new CustomEvent("metadata-updated", { detail: { fileId } }));
  } catch (e) {
    console.warn(`[${META_MODULE}] duration-update-notify-failed`, classifyMetaError(e));
  }
}
