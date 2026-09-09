package app.tauri.nativeaudio

import android.Manifest
import android.app.Activity
import android.app.PendingIntent
import android.content.Context
import android.content.SharedPreferences
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.app.ActivityManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.session.MediaSession
import org.json.JSONObject
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import kotlin.math.max

private const val TAG = "plugin/native-audio"
private const val EVENT_STATE = "native_audio_state"
private const val NOTIFICATION_PERMISSION_REQUEST_CODE = 9512
private const val FOREGROUND_PROGRESS_TICK_MS = 25L
private const val BACKGROUND_PROGRESS_TICK_MS = 250L
private const val SEEK_INCREMENT_MS = 10_000L
private const val SEEK_STATE_STALE_MS = 1_500L
private const val PROGRESS_PERSIST_THROTTLE_MS = 1_000L
private const val PROGRESS_NEAR_START_EPSILON_SEC = 0.25
private const val PROGRESS_PERSIST_EPSILON_SEC = 0.05
private const val PROGRESS_PREFS_NAME = "tauri_native_audio_progress"
private const val PROGRESS_KEY_STORY_ID = "story_id"
private const val PROGRESS_KEY_CURRENT_TIME = "current_time"
private const val PROGRESS_KEY_UPDATED_AT_MS = "updated_at_ms"
private const val PROGRESS_KEY_STATUS = "status"

// DrPlay fork: resume-snapshot keys in the same prefs file. These persist the
// minimum data needed to rebuild one MediaItem after process death (Bug 2):
// src is mandatory; metadata + headers are best-effort extras.
private const val RESUME_KEY_SRC = "resume_src"
private const val RESUME_KEY_TITLE = "resume_title"
private const val RESUME_KEY_ARTIST = "resume_artist"
private const val RESUME_KEY_ARTWORK = "resume_artwork"
private const val RESUME_KEY_HEADERS_JSON = "resume_headers_json"
// Track id (Drive file id, a String) of the resumed item — distinct from the
// progress checkpoint's story id (PROGRESS_KEY_STORY_ID, a numeric Long).
private const val RESUME_KEY_TRACK_ID = "resume_track_id"

// Repeat-mode strings accepted by set_queue. Anything else (including null)
// maps to REPEAT_MODE_OFF, i.e. normal end-of-queue behavior.
private const val REPEAT_MODE_ONE = "repeat-one"
private const val REPEAT_MODE_ALL = "repeat-all"
private const val REPEAT_MODE_SHUFFLE = "shuffle"

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
private data class QueueEntry(
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

private data class PendingSeekState(
    val shouldResume: Boolean,
    val startedAtMs: Long,
)

object NativeAudioRuntime {
    private val lock = Any()
    private val tickHandler = Handler(Looper.getMainLooper())
    private var tickScheduled = false

    private var player: ExoPlayer? = null
    private var appContext: Context? = null
    private var mediaSession: MediaSession? = null
    private var mediaSessionPlayer: Player? = null
    private var lastError: String? = null
    private var pendingSeekState: PendingSeekState? = null
    private var currentStoryId: Long? = null
    // DrPlay fork: media id (track id string) of the current item, tracked at
    // every media-item transition and shipped in the state snapshot so the
    // JS side can sync its store on native auto-advance. currentStoryId
    // (Long) stays authoritative for the progress checkpoint flow.
    private var currentMediaId: String? = null
    private var lastProgressPersistedAtMs = 0L
    private var lastProgressPersistedStoryId: Long? = null
    private var lastProgressPersistedTimeSec: Double? = null
    // DrPlay fork: playlist mirror for resume persistence (see QueueEntry) and
    // the last header batch applied to httpDataSourceFactory. Both live under
    // `lock`.
    private var queueItems: List<QueueEntry> = emptyList()
    private var lastAppliedHeaders: Map<String, String>? = null

    // DrPlay fork: single HTTP data source factory for authenticated streaming.
    // setDefaultRequestProperties is mutable — setSource applies the current
    // per-track headers right before setMediaItem so every new source starts
    // with the right Authorization header.
    @OptIn(UnstableApi::class)
    private val httpDataSourceFactory: DefaultHttpDataSource.Factory =
        DefaultHttpDataSource.Factory()

    // DrPlay fork: process-death resumption hook (Bug 2). media3 1.4.1 puts
    // onPlaybackResumption on MediaSession.Callback — NOT on MediaSessionService
    // (verified against MediaSessionService.java / MediaSession.java at tag
    // 1.4.1) — so it is attached to the session builder in ensure(). Returning
    // a failed future when nothing is persisted mirrors the default
    // implementation (immediateFailedFuture(UnsupportedOperationException)).
    // Pure data work only (prefs read + object build), no player access.
    @OptIn(UnstableApi::class)
    private val resumptionSessionCallback = object : MediaSession.Callback {
        override fun onPlaybackResumption(
            mediaSession: MediaSession,
            controller: MediaSession.ControllerInfo,
        ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
            val context = appContext
            if (context == null) {
                Log.w(TAG, "onPlaybackResumption: runtime not initialized, cannot resume")
                return Futures.immediateFailedFuture(
                    IllegalStateException("native audio runtime not initialized")
                )
            }
            val data = resumptionSnapshot(context)
            if (data == null) {
                Log.w(TAG, "onPlaybackResumption: no resumable audio state persisted")
                return Futures.immediateFailedFuture(
                    IllegalStateException("no resumable audio state persisted")
                )
            }
            // Re-apply the persisted headers BEFORE the session prepares the
            // player: a fresh process starts with an empty default header set,
            // so an authenticated (Drive) source would 401 without this.
            // Header values are never logged.
            httpDataSourceFactory.setDefaultRequestProperties(data.headers ?: emptyMap())
            val mediaItem = buildMediaItem(data.src, data.title, data.artist, data.artworkUrl, data.trackId)
            return Futures.immediateFuture(
                MediaSession.MediaItemsWithStartPosition(
                    listOf(mediaItem), 0, (data.positionSec * 1000.0).toLong(),
                )
            )
        }
    }

    private val tickRunnable = object : Runnable {
        override fun run() {
            val shouldContinue = synchronized(lock) {
                val snapshot = snapshotLocked()
                appContext?.let { persistProgressCheckpointLocked(it, snapshot, force = false) }
                NativeAudioPlugin.emitToActive(snapshot)
                val isPlaying = player?.isPlaying == true
                tickScheduled = isPlaying
                isPlaying
            }
            if (shouldContinue) {
                val delay = synchronized(lock) { nextProgressTickDelayLocked() }
                tickHandler.postDelayed(this, delay)
            }
        }
    }

    private val playerListener = object : Player.Listener {
        override fun onPlaybackStateChanged(playbackState: Int) {
            if (playbackState == Player.STATE_ENDED) {
                synchronized(lock) {
                    appContext?.let { persistProgressCheckpointLocked(it, snapshotLocked(), force = true) }
                }
            }
            syncTicking()
            emitState()
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            syncTicking()
            emitState()
        }

        // DrPlay fork: with a queue, ExoPlayer advances to the next item
        // NATIVELY on STATE_ENDED — no WebView round-trip needed (Bug 3: a
        // backgrounded WebView gets suspended and the JS-driven advance
        // never runs). The listener also keeps the progress checkpoint and
        // the process-death resume snapshot in sync with the new item.
        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
            synchronized(lock) {
                // Track the item id as a raw string (Drive file ids are not
                // numeric); setMediaId on queue items keeps this non-empty,
                // while setSource items keep the default "" and are ignored.
                val id = mediaItem?.mediaId?.takeIf { it.isNotEmpty() }
                if (id != null) currentMediaId = id
                appContext?.let { persistProgressCheckpointLocked(it, snapshotLocked(), force = true) }
                appContext?.let { persistResumeDataLocked(it, mediaItem) }
            }
            syncTicking()
            emitState()
        }

        // DrPlay fork: the buffer bar must also grow while PAUSED. The 25ms
        // progress tick only runs while isPlaying, and Media3 has no event
        // dedicated to buffered-position changes — EVENT_IS_LOADING_CHANGED
        // is the closest signal (Player.java). Each emitState ships a fresh
        // getBufferedPosition() estimate; the JS bridge diffs values before
        // surfacing "progress", so unchanged pushes are free.
        override fun onIsLoadingChanged(isLoading: Boolean) {
            syncTicking()
            emitState()
        }

        override fun onPlaybackParametersChanged(playbackParameters: androidx.media3.common.PlaybackParameters) {
            emitState()
        }

        override fun onPositionDiscontinuity(
            oldPosition: Player.PositionInfo,
            newPosition: Player.PositionInfo,
            reason: Int,
        ) {
            if (reason == Player.DISCONTINUITY_REASON_SEEK || reason == Player.DISCONTINUITY_REASON_SEEK_ADJUSTMENT) {
                synchronized(lock) {
                    val exoPlayer = player ?: return@synchronized
                    val pendingSeek = pendingSeekState
                    val shouldResume = pendingSeek?.shouldResume ?: exoPlayer.playWhenReady
                    if (!shouldResume && exoPlayer.playWhenReady) exoPlayer.pause()
                    val shouldRecoverPlayback =
                        shouldResume &&
                            !exoPlayer.isPlaying &&
                            exoPlayer.playbackState == Player.STATE_READY &&
                            lastError == null
                    if (shouldRecoverPlayback) exoPlayer.play()
                    // DrPlay fork: reaching this branch means the seek has been
                    // APPLIED by ExoPlayer (Player.java: DISCONTINUITY_REASON_SEEK
                    // fires for "seek within the current period or to another
                    // period"; SEEK_ADJUSTMENT is its inexact-position variant).
                    // Clear the pending marker BEFORE the snapshot below so
                    // effectiveBuffering reports the player's real buffering state
                    // instead of staying masked false for up to
                    // SEEK_STATE_STALE_MS after the seek lands. If a newer seek
                    // was dispatched in the meantime, dropping its mask early only
                    // surfaces the truth sooner (TS coalesces seeks since 8c43bf2),
                    // so no revision tracking is needed here.
                    if (pendingSeek != null) {
                        pendingSeekState = null
                        Log.i(TAG, "seek landed, cleared pendingSeekState shouldResume=$shouldResume")
                    }
                    appContext?.let { persistProgressCheckpointLocked(it, snapshotLocked(), force = true) }
                }
            }
            syncTicking()
            emitState()
        }

        override fun onPlayerError(error: PlaybackException) {
            Log.e(TAG, "onPlayerError code=${error.errorCodeName} message=${error.message}", error)
            synchronized(lock) {
                // DrPlay fork: forward the real error code name (e.g.
                // ERROR_CODE_PARSER_CONTAINER_UNSUPPORTED / ERROR_CODE_IO_*)
                // instead of a bare message so the JS side can tell a
                // container/seek failure (m4a moov-at-end) apart from a
                // network or decoder one. The JS still maps every error to
                // code "format_error" — only the diagnostics text changes.
                lastError = "${error.errorCodeName}: ${error.message ?: "unknown"}"
                pendingSeekState = null
            }
            syncTicking()
            emitState()
        }
    }

    @OptIn(UnstableApi::class)
    fun ensure(context: Context) {
        synchronized(lock) {
            if (player != null && mediaSession != null) return

            val ctx = context.applicationContext
            appContext = ctx

            val audioAttributes = AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                .build()

            val exoPlayer = ExoPlayer.Builder(ctx)
                .setSeekBackIncrementMs(SEEK_INCREMENT_MS)
                .setSeekForwardIncrementMs(SEEK_INCREMENT_MS)
                .setMediaSourceFactory(
                    DefaultMediaSourceFactory(httpDataSourceFactory, DefaultExtractorsFactory())
                )
                .build()
            exoPlayer.setAudioAttributes(audioAttributes, true)
            exoPlayer.setHandleAudioBecomingNoisy(true)
            exoPlayer.setWakeMode(C.WAKE_MODE_LOCAL)
            exoPlayer.addListener(playerListener)
            player = exoPlayer
            mediaSessionPlayer = object : ForwardingPlayer(exoPlayer) {
                override fun getAvailableCommands(): Player.Commands {
                    return super.getAvailableCommands()
                        .buildUpon()
                        .add(Player.COMMAND_SEEK_BACK)
                        .add(Player.COMMAND_SEEK_FORWARD)
                        .add(Player.COMMAND_SEEK_TO_PREVIOUS)
                        .add(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
                        .add(Player.COMMAND_SEEK_TO_NEXT)
                        .add(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
                        .build()
                }

                override fun isCommandAvailable(command: Int): Boolean {
                    if (command == Player.COMMAND_SEEK_BACK || command == Player.COMMAND_SEEK_FORWARD) return true
                    if (command == Player.COMMAND_SEEK_TO_PREVIOUS || command == Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM) return true
                    if (command == Player.COMMAND_SEEK_TO_NEXT || command == Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM) return true
                    return super.isCommandAvailable(command)
                }

                override fun seekToPrevious() {
                    exoPlayer.seekBack()
                }

                override fun seekToPreviousMediaItem() {
                    exoPlayer.seekBack()
                }

                override fun seekToNext() {
                    exoPlayer.seekForward()
                }

                override fun seekToNextMediaItem() {
                    exoPlayer.seekForward()
                }

                override fun play() {
                    // Route media-session/notification play through the runtime
                    // recovery path (seekTo(0) after STATE_ENDED, prepare()
                    // after a latched error) — a raw exoPlayer.play() is a
                    // silent no-op in both terminal states. Runtime.play() calls
                    // play() on the raw ExoPlayer field, so this does not recurse.
                    appContext?.let { NativeAudioRuntime.play(it) }
                }
            }

            val launchIntent = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
            val pendingIntent = launchIntent?.let {
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                    (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)
                PendingIntent.getActivity(ctx, 0, it, flags)
            }

            val sessionPlayer = mediaSessionPlayer ?: exoPlayer
            mediaSession = MediaSession.Builder(ctx, sessionPlayer)
                .apply {
                    if (pendingIntent != null) setSessionActivity(pendingIntent)
                    setCallback(resumptionSessionCallback)
                }
                .build()

            lastError = null
            syncTickingLocked()
        }
    }

    fun initialize(context: Context) {
        ensure(context)
        emitState()
    }

    fun startService(context: Context) {
        val serviceIntent = Intent(context.applicationContext, NativeAudioService::class.java)
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.applicationContext.startForegroundService(serviceIntent)
            } else {
                context.applicationContext.startService(serviceIntent)
            }
        }.onFailure { error ->
            Log.w(TAG, "startService failed", error)
        }
    }

    fun stopService(context: Context) {
        val serviceIntent = Intent(context.applicationContext, NativeAudioService::class.java)
        context.applicationContext.stopService(serviceIntent)
    }

    @OptIn(UnstableApi::class)
    fun setSource(context: Context, src: String, storyId: Long?, title: String?, artist: String?, artworkUrl: String?, headers: Map<String, String>?) {
        synchronized(lock) {
            ensure(context)
            val exoPlayer = player ?: return

            // DrPlay fork: apply (or clear) the per-source request headers
            // before loading. The factory is read by the media source on
            // prepare(), so mutating it here is safe for the next setMediaItem.
            httpDataSourceFactory.setDefaultRequestProperties(headers ?: emptyMap())
            lastAppliedHeaders = headers

            val mediaItem = buildMediaItem(src, title, artist, artworkUrl)

            pendingSeekState = null
            currentStoryId = storyId?.takeIf { it > 0 }
            // The new source carries no string media id — clear any queue-era
            // value so snapshots cannot surface a stale track id.
            currentMediaId = null
            // Single-item queue mirror: persistResumeDataLocked reads the
            // current item uniformly by index for both setSource and set_queue.
            queueItems = listOf(
                QueueEntry(
                    src = src,
                    trackId = null,
                    title = title,
                    artist = artist,
                    artworkUrl = artworkUrl,
                )
            )
            exoPlayer.setMediaItem(mediaItem)
            exoPlayer.prepare()
            lastError = null
            syncTickingLocked()
        }
        emitState()
    }

    // DrPlay fork: queue playback so ExoPlayer auto-advances NATIVELY when a
    // track ends (Bug 3 — the previous advance path went through the WebView,
    // which the system suspends in background and the music stops between
    // tracks). Mirrors setSource: prepare only, never auto-play (JS calls
    // play() itself). One shared header batch covers the whole queue (Drive:
    // same token for every track).
    @OptIn(UnstableApi::class)
    fun setQueue(
        context: Context,
        items: List<QueueItemArg>,
        startIndex: Int,
        headers: Map<String, String>?,
        repeatMode: String?,
    ) {
        synchronized(lock) {
            ensure(context)
            val exoPlayer = player ?: return

            val entries = items.mapNotNull { item ->
                val src = item.src?.trim().orEmpty()
                if (src.isEmpty()) {
                    Log.w(TAG, "set_queue: dropping item without src (id=${item.id})")
                    null
                } else {
                    QueueEntry(
                        src = src,
                        trackId = item.id?.takeIf { it.isNotBlank() },
                        title = item.title,
                        artist = item.artist,
                        artworkUrl = item.artworkUrl,
                    )
                }
            }
            if (entries.isEmpty()) {
                lastError = "set_queue: no playable items"
                Log.w(TAG, lastError ?: "")
                syncTickingLocked()
                return
            }

            httpDataSourceFactory.setDefaultRequestProperties(headers ?: emptyMap())
            lastAppliedHeaders = headers

            val repeatModeFlag = when (repeatMode) {
                REPEAT_MODE_ONE -> Player.REPEAT_MODE_ONE
                REPEAT_MODE_ALL, REPEAT_MODE_SHUFFLE -> Player.REPEAT_MODE_ALL
                else -> Player.REPEAT_MODE_OFF
            }
            exoPlayer.repeatMode = repeatModeFlag
            // Guarantee the "no auto-play" contract: a set_queue arriving while
            // the player is mid-playback must NOT silently start the new queue;
            // the JS side calls play() itself.
            exoPlayer.playWhenReady = false
            // Mirror assigned BEFORE setMediaItems: onMediaItemTransition (which
            // persists the resume snapshot by playlist index) reads queueItems,
            // and ExoPlayer may deliver the transition callback as soon as the
            // playlist changes.
            queueItems = entries
            exoPlayer.setMediaItems(
                entries.map { entry ->
                    buildMediaItem(entry.src, entry.title, entry.artist, entry.artworkUrl, entry.trackId)
                },
                startIndex.coerceIn(0, entries.size - 1),
                0L,
            )
            exoPlayer.prepare()

            pendingSeekState = null
            // currentMediaId is updated naturally by onMediaItemTransition
            // (queue items carry the track id as mediaId).
            lastError = null
            syncTickingLocked()
        }
        emitState()
    }

    // DrPlay fork: Media3 puts the player into STATE_IDLE after onPlayerError,
    // and only prepare() leaves that state (ExoPlayerImplInternal.prepareInternal
    // resets the error and resumes loading from the retained position; the
    // doSomeWork loop bails out with "Prepare (in case of IDLE) will resume").
    // ExoPlayer.retry() does not exist in media3 1.4.1 (added in 1.5.0), so
    // prepare() is the correct recovery call for this dependency set. Without
    // it, a latched error turned play()/seekTo() into silent no-ops and the
    // JS side saw a fake-success snapshot (status "error", position frozen).
    // Caller must hold the lock. Returns true when recovery ran.
    private fun prepareIfErrorLatchedLocked(exoPlayer: ExoPlayer): Boolean {
        if (lastError == null) return false
        Log.i(TAG, "recovering latched error via prepare(), state=${exoPlayer.playbackState}")
        lastError = null
        exoPlayer.prepare()
        return true
    }

    fun play(context: Context) {
        // ensure() first: the service's onCreate reads the runtime session to
        // build the notification manager. Starting the service before the
        // session exists would leave the notification never posted.
        synchronized(lock) {
            ensure(context)
            val exoPlayer = player ?: return
            prepareIfErrorLatchedLocked(exoPlayer)
            if (exoPlayer.playbackState == Player.STATE_ENDED) {
                exoPlayer.seekTo(0L)
            }
            pendingSeekState = null
            exoPlayer.playWhenReady = true
            exoPlayer.play()
            syncTickingLocked()
        }
        startService(context)
        emitState()
    }

    fun pause(context: Context) {
        synchronized(lock) {
            ensure(context)
            pendingSeekState = null
            player?.pause()
            syncTickingLocked()
            persistProgressCheckpointLocked(context.applicationContext, snapshotLocked(), force = true)
        }
        emitState()
    }

    fun seekTo(context: Context, positionSec: Double) {
        if (!positionSec.isFinite()) return
        synchronized(lock) {
            ensure(context)
            val safeMs = max(0L, (positionSec * 1000.0).toLong())
            val exoPlayer = player ?: return@synchronized
            // Recover BEFORE the seek: in the post-error STATE_IDLE a raw seekTo
            // resolves through the masking layer but the internal player stays
            // idle, so without prepare() this command returned a fake-success
            // snapshot and never moved playback. prepare() first puts the player
            // into BUFFERING (still with the previous media item), then the seek
            // below is a regular buffered seek and the position discontinuity
            // handler resumes playback if shouldResume.
            prepareIfErrorLatchedLocked(exoPlayer)
            val shouldResume = exoPlayer.playWhenReady || exoPlayer.isPlaying
            pendingSeekState = PendingSeekState(shouldResume = shouldResume, startedAtMs = System.currentTimeMillis())
            if (!shouldResume && exoPlayer.playWhenReady) exoPlayer.pause()
            exoPlayer.seekTo(safeMs)
        }
        emitState()
    }

    fun setRate(context: Context, rate: Double) {
        if (!rate.isFinite() || rate <= 0.0) return
        synchronized(lock) {
            ensure(context)
            player?.setPlaybackSpeed(rate.toFloat())
        }
        emitState()
    }

    fun getState(context: Context): NativeAudioState {
        synchronized(lock) {
            ensure(context)
            return snapshotLocked()
        }
    }

    fun getProgressCheckpoint(context: Context): NativeAudioProgressCheckpoint? {
        val prefs = progressPrefs(context.applicationContext)
        val storyId = prefs.getLong(PROGRESS_KEY_STORY_ID, 0L)
        if (storyId <= 0L) return null
        val currentTime = prefs.getFloat(PROGRESS_KEY_CURRENT_TIME, 0f).toDouble()
        val updatedAtMs = prefs.getLong(PROGRESS_KEY_UPDATED_AT_MS, 0L)
        if (!currentTime.isFinite() || currentTime <= 0.0 || updatedAtMs <= 0L) return null
        val status = prefs.getString(PROGRESS_KEY_STATUS, null)
        return NativeAudioProgressCheckpoint(
            id = storyId,
            currentTime = currentTime,
            updatedAtMs = updatedAtMs,
            status = status,
        )
    }

    fun clearProgressCheckpoint(context: Context) {
        synchronized(lock) {
            progressPrefs(context.applicationContext).edit()
                .remove(PROGRESS_KEY_STORY_ID)
                .remove(PROGRESS_KEY_CURRENT_TIME)
                .remove(PROGRESS_KEY_UPDATED_AT_MS)
                .remove(PROGRESS_KEY_STATUS)
                .apply()
            lastProgressPersistedAtMs = 0L
            lastProgressPersistedStoryId = null
            lastProgressPersistedTimeSec = null
        }
    }

    // ---- DrPlay fork: process-death resume snapshot (Bug 2) ----
    // Persisted in the same app-private prefs file as the progress checkpoint
    // (no secrets in logs; header values are sensitive but stored only in
    // app-private storage, mirroring where the JS side already keeps the
    // token, and wiped on dispose()).

    private fun persistResumeDataLocked(context: Context, mediaItem: MediaItem?) {
        val entry: QueueEntry? = if (mediaItem != null) {
            // Prefer the in-memory mirror, resolved by the current playlist
            // index; fall back to matching by track id for safety.
            val index = player?.currentMediaItemIndex
            queueItems.getOrNull(index ?: -1)
                ?: mediaItem.mediaId.takeIf { it.isNotEmpty() }?.let { id ->
                    queueItems.firstOrNull { it.trackId == id }
                }
        } else {
            null
        }
        if (entry == null) return

        progressPrefs(context).edit()
            .putString(RESUME_KEY_SRC, entry.src)
            .putString(RESUME_KEY_TITLE, entry.title)
            .putString(RESUME_KEY_ARTIST, entry.artist)
            .putString(RESUME_KEY_ARTWORK, entry.artworkUrl)
            .putString(RESUME_KEY_HEADERS_JSON, encodeHeaders(lastAppliedHeaders))
            .putString(RESUME_KEY_TRACK_ID, entry.trackId)
            .apply()
    }

    private fun clearResumeData(context: Context) {
        progressPrefs(context).edit()
            .remove(RESUME_KEY_SRC)
            .remove(RESUME_KEY_TITLE)
            .remove(RESUME_KEY_ARTIST)
            .remove(RESUME_KEY_ARTWORK)
            .remove(RESUME_KEY_HEADERS_JSON)
            .remove(RESUME_KEY_TRACK_ID)
            .apply()
    }

    fun resumptionSnapshot(context: Context): ResumptionData? {
        val prefs = progressPrefs(context.applicationContext)
        val src = prefs.getString(RESUME_KEY_SRC, null)?.trim().orEmpty()
        if (src.isEmpty()) return null
        val positionSec = prefs.getFloat(PROGRESS_KEY_CURRENT_TIME, 0f).toDouble()
        if (!positionSec.isFinite() || positionSec <= 0.0) return null
        val trackId = prefs.getString(RESUME_KEY_TRACK_ID, null)?.trim()?.takeIf { it.isNotEmpty() }
        return ResumptionData(
            src = src,
            title = prefs.getString(RESUME_KEY_TITLE, null),
            artist = prefs.getString(RESUME_KEY_ARTIST, null),
            artworkUrl = prefs.getString(RESUME_KEY_ARTWORK, null),
            headers = decodeHeaders(prefs.getString(RESUME_KEY_HEADERS_JSON, null)),
            positionSec = positionSec,
            trackId = trackId,
        )
    }

    // org.json is part of the Android platform (no extra dependency). Logs
    // carry the header KEY COUNT only — never key names or values.
    private fun encodeHeaders(headers: Map<String, String>?): String? {
        if (headers.isNullOrEmpty()) return null
        return runCatching { JSONObject(headers).toString() }
            .onFailure { error ->
                Log.w(TAG, "encodeHeaders failed for ${headers.size} headers", error)
            }
            .getOrNull()
    }

    private fun decodeHeaders(json: String?): Map<String, String>? {
        if (json.isNullOrBlank()) return null
        return runCatching {
            val obj = JSONObject(json)
            val out = LinkedHashMap<String, String>()
            for (key in obj.keys()) {
                out[key] = obj.getString(key)
            }
            out
        }.onFailure { error ->
            // Value-less log: key count only, no values (Authorization Bearer).
            Log.w(TAG, "decodeHeaders failed for json with ${json.length} chars", error)
        }.getOrNull()
    }

    fun dispose(context: Context) {
        synchronized(lock) {
            persistProgressCheckpointLocked(context.applicationContext, snapshotLocked(), force = true)
            tickHandler.removeCallbacks(tickRunnable)
            tickScheduled = false

            player?.removeListener(playerListener)
            player?.release()
            player = null

            mediaSession?.release()
            mediaSession = null
            mediaSessionPlayer = null

            lastError = null
            pendingSeekState = null
            currentStoryId = null
            currentMediaId = null
            queueItems = emptyList()
            lastAppliedHeaders = null
            appContext = null
        }
        // Clear outside the runtime lock: dispose() intentionally wipes the
        // resume snapshot too — after an explicit JS dispose there is nothing
        // meaningful to resume after process death.
        clearResumeData(context.applicationContext)
        stopService(context)
        emitState()
    }

    fun mediaSession(): MediaSession? {
        synchronized(lock) {
            return mediaSession
        }
    }

    fun mediaSessionPlayer(): Player? {
        synchronized(lock) {
            return mediaSessionPlayer ?: player
        }
    }

    private fun syncTicking() {
        synchronized(lock) {
            syncTickingLocked()
        }
    }

    private fun syncTickingLocked() {
        val isPlaying = player?.isPlaying == true
        if (isPlaying && !tickScheduled) {
            tickScheduled = true
            tickHandler.removeCallbacks(tickRunnable)
            tickHandler.post(tickRunnable)
            return
        }
        if (!isPlaying && tickScheduled) {
            tickScheduled = false
            tickHandler.removeCallbacks(tickRunnable)
        }
    }

    private fun nextProgressTickDelayLocked(): Long {
        val context = appContext ?: return BACKGROUND_PROGRESS_TICK_MS
        val isForeground = isAppInForeground()
        val isInteractive = isDeviceInteractive(context)
        return if (isForeground && isInteractive) FOREGROUND_PROGRESS_TICK_MS else BACKGROUND_PROGRESS_TICK_MS
    }

    private fun isAppInForeground(): Boolean {
        val processInfo = ActivityManager.RunningAppProcessInfo()
        ActivityManager.getMyMemoryState(processInfo)
        return processInfo.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND ||
            processInfo.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE
    }

    private fun isDeviceInteractive(context: Context): Boolean {
        val powerManager = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
        return powerManager?.isInteractive ?: true
    }

    private fun emitState() {
        val snapshot = synchronized(lock) { snapshotLocked() }
        NativeAudioPlugin.emitToActive(snapshot)
    }

    private fun progressPrefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PROGRESS_PREFS_NAME, Context.MODE_PRIVATE)

    private fun persistProgressCheckpointLocked(context: Context, snapshot: NativeAudioState, force: Boolean) {
        val storyId = currentStoryId ?: return
        if (storyId <= 0L) return
        if (!snapshot.currentTime.isFinite() || snapshot.currentTime <= PROGRESS_NEAR_START_EPSILON_SEC) return

        val now = System.currentTimeMillis()
        if (!force && now - lastProgressPersistedAtMs < PROGRESS_PERSIST_THROTTLE_MS) return

        val prevStoryId = lastProgressPersistedStoryId
        val prevTime = lastProgressPersistedTimeSec
        if (!force && prevStoryId == storyId && prevTime != null && kotlin.math.abs(prevTime - snapshot.currentTime) <= PROGRESS_PERSIST_EPSILON_SEC) {
            return
        }

        progressPrefs(context).edit()
            .putLong(PROGRESS_KEY_STORY_ID, storyId)
            .putFloat(PROGRESS_KEY_CURRENT_TIME, snapshot.currentTime.toFloat())
            .putLong(PROGRESS_KEY_UPDATED_AT_MS, now)
            .putString(PROGRESS_KEY_STATUS, snapshot.status)
            .apply()

        lastProgressPersistedAtMs = now
        lastProgressPersistedStoryId = storyId
        lastProgressPersistedTimeSec = snapshot.currentTime
    }

    private fun buildMediaItem(
        src: String,
        title: String?,
        artist: String?,
        artworkUrl: String?,
        mediaId: String? = null,
    ): MediaItem {
        val metadataBuilder = MediaMetadata.Builder()
        if (!title.isNullOrBlank()) metadataBuilder.setTitle(title)
        if (!artist.isNullOrBlank()) metadataBuilder.setArtist(artist)
        if (!artworkUrl.isNullOrBlank()) {
            runCatching { Uri.parse(artworkUrl) }
                .onSuccess { metadataBuilder.setArtworkUri(it) }
        }
        val itemBuilder = MediaItem.Builder()
            .setUri(src)
            .setMediaMetadata(metadataBuilder.build())
        // Queue items carry the track id as mediaId so onMediaItemTransition
        // (and the JS state sync) can identify the current item; the default
        // mediaId is "" and is left untouched for setSource items.
        if (!mediaId.isNullOrEmpty()) itemBuilder.setMediaId(mediaId)
        return itemBuilder.build()
    }

    private fun snapshotLocked(): NativeAudioState {
        val exoPlayer = player
            ?: return NativeAudioState(
                status = "idle",
                currentTime = 0.0,
                duration = 0.0,
                isPlaying = false,
                buffering = false,
                rate = 1.0,
                error = null,
            )

        val rawDurationMs = exoPlayer.duration
        val durationMs = if (rawDurationMs > 0) rawDurationMs else 0L
        val currentMs = max(0L, exoPlayer.currentPosition)
        // DrPlay fork: Media3's getBufferedPosition is an ESTIMATE in ms
        // (Player.java: "Returns an estimate of the position ... up to which
        // data is buffered") and can transiently overshoot the duration while
        // the estimate settles. Clamp into [0, durationMs] so the JS buffer
        // bar can never exceed the rail; with no known duration the estimate
        // is meaningless, so report 0.
        // https://developer.android.com/reference/androidx/media3/common/Player#getBufferedPosition()
        val bufferedMs = if (durationMs > 0) {
            exoPlayer.bufferedPosition.coerceIn(0L, durationMs)
        } else {
            0L
        }
        val buffering = exoPlayer.playbackState == Player.STATE_BUFFERING

        val seekState = activeSeekStateLocked()
        if (seekState?.shouldResume == true && exoPlayer.isPlaying) pendingSeekState = null

        val hasTerminalState = lastError != null || exoPlayer.playbackState == Player.STATE_ENDED
        if (hasTerminalState) pendingSeekState = null
        val effectiveIsPlaying = if (hasTerminalState) false else (seekState?.shouldResume ?: exoPlayer.isPlaying)
        val effectiveBuffering = if (hasTerminalState || seekState?.shouldResume == false) false else buffering

        val status = when {
            lastError != null -> "error"
            exoPlayer.playbackState == Player.STATE_ENDED -> "ended"
            seekState?.shouldResume == true -> "playing"
            effectiveBuffering -> "loading"
            effectiveIsPlaying -> "playing"
            else -> "idle"
        }

        return NativeAudioState(
            status = status,
            currentTime = currentMs / 1000.0,
            duration = durationMs / 1000.0,
            // Same ms→seconds convention as currentTime/duration above.
            bufferedPosition = bufferedMs / 1000.0,
            isPlaying = effectiveIsPlaying,
            buffering = effectiveBuffering,
            rate = exoPlayer.playbackParameters.speed.toDouble(),
            error = lastError,
            mediaId = currentMediaId,
        )
    }

    private fun activeSeekStateLocked(): PendingSeekState? {
        val seekState = pendingSeekState ?: return null
        val now = System.currentTimeMillis()
        if (now - seekState.startedAtMs > SEEK_STATE_STALE_MS) {
            pendingSeekState = null
            return null
        }
        return seekState
    }
}

@TauriPlugin
class NativeAudioPlugin(private val activity: Activity) : Plugin(activity) {

    init {
        activeInstance = this
    }

    @Command
    fun initialize(invoke: Invoke) {
        requestNotificationPermission()
        runCatching {
            NativeAudioRuntime.initialize(activity.applicationContext)
        }.onSuccess {
            invoke.resolve(toJsObject(NativeAudioRuntime.getState(activity.applicationContext)))
        }.onFailure {
            invoke.reject(it.message ?: "initialize failed")
        }
    }

    @Command
    fun register_listener(invoke: Invoke) {
        invoke.resolve()
    }

    @Command
    fun remove_listener(invoke: Invoke) {
        invoke.resolve()
    }

    @Command
    fun setSource(invoke: Invoke) {
        val args = invoke.parseArgs(SetSourceArgs::class.java)
        val src = args.src?.trim().orEmpty()
        if (src.isEmpty()) {
            invoke.reject("src is required")
            return
        }

        runCatching {
            NativeAudioRuntime.setSource(activity.applicationContext, src, args.id, args.title, args.artist, args.artworkUrl, args.headers)
        }.onSuccess {
            invoke.resolve(toJsObject(NativeAudioRuntime.getState(activity.applicationContext)))
        }.onFailure {
            invoke.reject(it.message ?: "setSource failed")
        }
    }

    @Command
    fun setQueue(invoke: Invoke) {
        val args = invoke.parseArgs(SetQueueArgs::class.java)
        val startIndex = args.startIndex ?: 0
        if (startIndex < 0) {
            invoke.reject("startIndex must be >= 0")
            return
        }
        if (args.items.isEmpty()) {
            invoke.reject("items must not be empty")
            return
        }

        runCatching {
            NativeAudioRuntime.setQueue(
                activity.applicationContext,
                args.items,
                startIndex,
                args.headers,
                args.repeatMode,
            )
        }.onSuccess {
            invoke.resolve(toJsObject(NativeAudioRuntime.getState(activity.applicationContext)))
        }.onFailure {
            invoke.reject(it.message ?: "setQueue failed")
        }
    }

    @Command
    fun play(invoke: Invoke) {
        // Re-request at the moment the user actually wants audio — the
        // first-launch dialog may have been dismissed/denied. If denied,
        // playback still runs (foreground service); only the notification
        // shade entry is hidden (standard Android 13+ behavior).
        requestNotificationPermission()
        runCatching {
            NativeAudioRuntime.play(activity.applicationContext)
        }.onSuccess {
            invoke.resolve(toJsObject(NativeAudioRuntime.getState(activity.applicationContext)))
        }.onFailure {
            invoke.reject(it.message ?: "play failed")
        }
    }

    @Command
    fun pause(invoke: Invoke) {
        runCatching {
            NativeAudioRuntime.pause(activity.applicationContext)
        }.onSuccess {
            invoke.resolve(toJsObject(NativeAudioRuntime.getState(activity.applicationContext)))
        }.onFailure {
            invoke.reject(it.message ?: "pause failed")
        }
    }

    @Command
    fun seekTo(invoke: Invoke) {
        val args = invoke.parseArgs(SeekToArgs::class.java)
        val position = args.position
        if (position == null || !position.isFinite()) {
            invoke.reject("position is required")
            return
        }

        runCatching {
            NativeAudioRuntime.seekTo(activity.applicationContext, position)
        }.onSuccess {
            invoke.resolve(toJsObject(NativeAudioRuntime.getState(activity.applicationContext)))
        }.onFailure {
            invoke.reject(it.message ?: "seekTo failed")
        }
    }

    @Command
    fun setRate(invoke: Invoke) {
        val args = invoke.parseArgs(SetRateArgs::class.java)
        val rate = args.rate
        if (rate == null || !rate.isFinite() || rate <= 0) {
            invoke.reject("rate must be > 0")
            return
        }

        runCatching {
            NativeAudioRuntime.setRate(activity.applicationContext, rate)
        }.onSuccess {
            invoke.resolve(toJsObject(NativeAudioRuntime.getState(activity.applicationContext)))
        }.onFailure {
            invoke.reject(it.message ?: "setRate failed")
        }
    }

    @Command
    fun getState(invoke: Invoke) {
        runCatching {
            NativeAudioRuntime.getState(activity.applicationContext)
        }.onSuccess {
            invoke.resolve(toJsObject(it))
        }.onFailure {
            invoke.reject(it.message ?: "getState failed")
        }
    }

    @Command
    fun getProgressCheckpoint(invoke: Invoke) {
        runCatching {
            NativeAudioRuntime.getProgressCheckpoint(activity.applicationContext)
        }.onSuccess {
            invoke.resolve(it?.let { checkpoint -> toJsObject(checkpoint) })
        }.onFailure {
            invoke.reject(it.message ?: "getProgressCheckpoint failed")
        }
    }

    @Command
    fun clearProgressCheckpoint(invoke: Invoke) {
        runCatching {
            NativeAudioRuntime.clearProgressCheckpoint(activity.applicationContext)
        }.onSuccess {
            invoke.resolve()
        }.onFailure {
            invoke.reject(it.message ?: "clearProgressCheckpoint failed")
        }
    }

    @Command
    fun dispose(invoke: Invoke) {
        runCatching {
            NativeAudioRuntime.dispose(activity.applicationContext)
        }.onSuccess {
            invoke.resolve()
        }.onFailure {
            invoke.reject(it.message ?: "dispose failed")
        }
    }

    override fun onDestroy() {
        if (activeInstance === this) activeInstance = null
        super.onDestroy()
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        ActivityCompat.requestPermissions(
            activity,
            arrayOf(Manifest.permission.POST_NOTIFICATIONS),
            NOTIFICATION_PERMISSION_REQUEST_CODE,
        )
    }

    private fun emitState(state: NativeAudioState) {
        val payload = toJsObject(state)
        activity.runOnUiThread {
            trigger(EVENT_STATE, payload)
        }
    }

    private fun toJsObject(state: NativeAudioState): JSObject {
        val payload = JSObject()
        payload.put("status", state.status)
        payload.put("currentTime", state.currentTime)
        payload.put("duration", state.duration)
        payload.put("bufferedPosition", state.bufferedPosition)
        payload.put("isPlaying", state.isPlaying)
        payload.put("buffering", state.buffering)
        payload.put("rate", state.rate)
        if (state.mediaId != null) payload.put("mediaId", state.mediaId)
        if (!state.error.isNullOrBlank()) payload.put("error", state.error)
        return payload
    }

    private fun toJsObject(checkpoint: NativeAudioProgressCheckpoint): JSObject {
        val payload = JSObject()
        payload.put("id", checkpoint.id)
        payload.put("currentTime", checkpoint.currentTime)
        payload.put("updatedAtMs", checkpoint.updatedAtMs)
        if (!checkpoint.status.isNullOrBlank()) payload.put("status", checkpoint.status)
        return payload
    }

    companion object {
        @Volatile
        private var activeInstance: NativeAudioPlugin? = null

        internal fun emitToActive(state: NativeAudioState) {
            activeInstance?.emitState(state)
        }
    }
}
