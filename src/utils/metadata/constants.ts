export const META_MODULE = "metadata";
export const JPEG_MIME = "image/jpeg";
export const METADATA_LRU_KEY = "__drplay_metadata_lru";
export const METADATA_KEY_PREFIX = "metadata_";
export const UNKNOWN_ARTIST = "Unknown Artist";
export const FALLBACK_AUDIO_FILENAME = "audio.mp3";
export const METADATA_UPDATED_EVENT = "metadata-updated";
export const V_PLACEHOLDER = 9;
// Real parsed entries carry v=8: searchEngine.isRealCacheEntry accepts any
// data.v < V_PLACEHOLDER, so real metadata becomes searchable while v:9
// placeholders stay invisible. Keep V_PLACEHOLDER untouched (tests depend on
// the exact 9).
export const REAL_METADATA_VERSION = 8;
export const FRESH_WRITE_WINDOW_MS = 5_000;
// ID3v2 tag budget (Task B): MP3s carry their cover inside the ID3v2 tag and
// music-metadata reads the WHOLE tag body up-front (one readToken) — a tag
// larger than the default 20MB fetch budget nuked the entire entry (v:9
// placeholder). These constants bound the raised per-file budget.
export const TAG_BUDGET_MAX = 32 * 1024 * 1024; // hard cap for the raised budget
export const COVER_SLACK_BYTES = 1 * 1024 * 1024; // 64KB chunk alignment + frame overhead
// Fix E: files at/above this size get a HEAD-CLAMPED parse (see
// getTrackMetadataImpl). Evidence: every range-fetch timeout observed in
// production was on 152-297MB files; nothing below 101MB ever timed out.
export const LARGE_FILE_THRESHOLD = 100 * 1024 * 1024;
// Window (bytes) after the first MPEG frame sync where an embedded duration
// tag (Xing/Info) must sit. Xing lives at frame+4+sideInfo (~25-40 bytes);
// 256 covers side info + Xing + LAME extension with margin.
export const DURATION_TAG_SCAN_BYTES = 256;

export const MAX_LRU_CACHE = 100;

export const CACHE_VERSION = 2;
export const INFLIGHT_TIMEOUT = 30_000;

// After one network/timeout failure for a fileId, re-mounts of that card
// (scroll/filter) are served a placeholder without touching the network for
// this long. Drive's first-byte delay is 30±5s, so the cooldown outlasts a
// single retry window and stops the re-hang loop while Drive is slow.
export const METADATA_NETWORK_COOLDOWN_MS = 60_000;

export const MAX_MEM_CACHE = 1000; // 1000 entries cap; entries may carry pictureData (thumb) so real usage can reach tens of MB - bounded by count, not bytes.

// Full-picture (≤2000px) memory LRU + IDB persistence gate. Thumbnails persist
// in IDB via cacheTrackMetadata; full pictures live in the LRU and are
// evicted oldest-first until BOTH caps hold. Small JPEG fulls additionally
// persist to IDB (cacheTrackMetadata) so a restart can re-seed the LRU.
export const FULL_PICTURE_MEM_ENTRIES_MAX = 64;
export const FULL_PICTURE_MEM_BYTES_MAX = 16 * 1024 * 1024;
// Byte cap for persisting the full variant to IDB (1MB): large JPEGs are
// memory-only — re-encoding them would cost more than the sharpness gains.
export const FULL_PERSIST_MAX_BYTES = 1 * 1024 * 1024;
