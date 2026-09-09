package app.tauri.nativeaudio

import app.tauri.annotation.InvokeArg

internal const val TAG = "plugin/native-audio"
internal const val EVENT_STATE = "native_audio_state"
internal const val NOTIFICATION_PERMISSION_REQUEST_CODE = 9512
internal const val FOREGROUND_PROGRESS_TICK_MS = 25L
internal const val BACKGROUND_PROGRESS_TICK_MS = 250L
internal const val SEEK_INCREMENT_MS = 10_000L
internal const val SEEK_STATE_STALE_MS = 1_500L
internal const val PROGRESS_PERSIST_THROTTLE_MS = 1_000L
internal const val PROGRESS_NEAR_START_EPSILON_SEC = 0.25
internal const val PROGRESS_PERSIST_EPSILON_SEC = 0.05
internal const val PROGRESS_PREFS_NAME = "tauri_native_audio_progress"
internal const val PROGRESS_KEY_STORY_ID = "story_id"
internal const val PROGRESS_KEY_CURRENT_TIME = "current_time"
internal const val PROGRESS_KEY_UPDATED_AT_MS = "updated_at_ms"
internal const val PROGRESS_KEY_STATUS = "status"

// DrPlay fork: resume-snapshot keys in the same prefs file. These persist the
// minimum data needed to rebuild one MediaItem after process death (Bug 2):
// src is mandatory; metadata + headers are best-effort extras.
internal const val RESUME_KEY_SRC = "resume_src"
internal const val RESUME_KEY_TITLE = "resume_title"
internal const val RESUME_KEY_ARTIST = "resume_artist"
internal const val RESUME_KEY_ARTWORK = "resume_artwork"
internal const val RESUME_KEY_HEADERS_JSON = "resume_headers_json"
// Track id (Drive file id, a String) of the resumed item — distinct from the
// progress checkpoint's story id (PROGRESS_KEY_STORY_ID, a numeric Long).
internal const val RESUME_KEY_TRACK_ID = "resume_track_id"

// Repeat-mode strings accepted by set_queue. Anything else (including null)
// maps to REPEAT_MODE_OFF, i.e. normal end-of-queue behavior.
internal const val REPEAT_MODE_ONE = "repeat-one"
internal const val REPEAT_MODE_ALL = "repeat-all"
internal const val REPEAT_MODE_SHUFFLE = "shuffle"

data class NativeAudioState(
    val status: String,
    val currentTime: Double,
    val duration: Double,
    val isPlaying: Boolean,
    val buffering: Boolean,
    val rate: Double,
    // DrPlay fork: buffered-end estimate in seconds (Media3
    // Player.getBufferedPosition) so the JS buffer bar can render on mobile.
    // Default 0.0 keeps every existing call site (idle fallback snapshots)
    // valid without changes; the JS side treats a missing/0 value as "no
    // buffered range".
    val bufferedPosition: Double = 0.0,
    val error: String? = null,
    // DrPlay fork: media id (track id string) of the currently loaded item.
    // Default null keeps every existing call site compiling; JS uses it to
    // sync the store when ExoPlayer auto-advances inside a native queue.
    val mediaId: String? = null,
)

data class NativeAudioProgressCheckpoint(
    val id: Long,
    val currentTime: Double,
    val updatedAtMs: Long,
    val status: String? = null,
)

@InvokeArg
class SetSourceArgs {
    var src: String? = null
    var id: Long? = null
    var title: String? = null
    var artist: String? = null
    var artworkUrl: String? = null
    // DrPlay fork: per-source HTTP headers (e.g. Authorization: Bearer <token>)
    // for authenticated Google Drive streaming. Applied as ExoPlayer default
    // request properties on every load. Never logged.
    var headers: Map<String, String>? = null
}

@InvokeArg
class SeekToArgs {
    var position: Double? = null
}

@InvokeArg
class SetRateArgs {
    var rate: Double? = null
}

// DrPlay fork: one queue entry for set_queue. Items without a src are dropped
// at the runtime layer (they can never be played).
@InvokeArg
class QueueItemArg {
    var src: String? = null
    // Drive file id — a String (numeric ids do not fit a Long).
    var id: String? = null
    var title: String? = null
    var artist: String? = null
    var artworkUrl: String? = null
}

@InvokeArg
class SetQueueArgs {
    var items: List<QueueItemArg> = emptyList()
    var startIndex: Int? = null
    // One batch of headers shared by the whole queue (Drive: same token for
    // every track). Never logged.
    var headers: Map<String, String>? = null
    var repeatMode: String? = null
}

// DrPlay fork: in-memory mirror of one playlist entry, used to persist the
// resume snapshot on media-item transitions (setSource keeps a single-element
// list; set_queue replaces it wholesale). trackId is the Drive file id string
// (the progress checkpoint's story id Long is unrelated and unchanged).
internal data class QueueEntry(
    val src: String,
    val trackId: String?,
    val title: String?,
    val artist: String?,
    val artworkUrl: String?,
)

// DrPlay fork: everything needed to rebuild a MediaItem after process death.
// Read from prefs in resumptionSnapshot; consumed by the MediaSession
// onPlaybackResumption callback.
data class ResumptionData(
    val src: String,
    val title: String?,
    val artist: String?,
    val artworkUrl: String?,
    val headers: Map<String, String>?,
    val positionSec: Double,
    val trackId: String?,
)

internal data class PendingSeekState(
    val shouldResume: Boolean,
    val startedAtMs: Long,
)
