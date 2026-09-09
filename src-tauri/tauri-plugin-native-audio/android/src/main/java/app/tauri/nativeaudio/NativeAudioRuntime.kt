package app.tauri.nativeaudio

import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import kotlin.math.max

object NativeAudioRuntime {
    internal val lock = Any()
    internal val ticker = PlaybackTicker(this)
    private val playerListener = NativePlayerListener(this)

    internal var player: ExoPlayer? = null
    internal var appContext: Context? = null
    private var mediaSession: MediaSession? = null
    private var mediaSessionPlayer: Player? = null
    internal var lastError: String? = null
    internal var pendingSeekState: PendingSeekState? = null
    private var currentStoryId: Long? = null
    // DrPlay fork: media id (track id string) of the current item, tracked at
    // every media-item transition and shipped in the state snapshot so the
    // JS side can sync its store on native auto-advance. currentStoryId
    // (Long) stays authoritative for the progress checkpoint flow.
    internal var currentMediaId: String? = null
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
    internal val httpDataSourceFactory: DefaultHttpDataSource.Factory =
        DefaultHttpDataSource.Factory()

    fun ensure(context: Context) {
        synchronized(lock) {
            if (player != null && mediaSession != null) return

            val ctx = context.applicationContext
            appContext = ctx

            val session = buildAudioSession(ctx, httpDataSourceFactory) {
                appContext?.let { NativeAudioRuntime.play(it) }
            }
            session.player.addListener(playerListener)
            player = session.player
            mediaSessionPlayer = session.mediaSessionPlayer
            mediaSession = session.mediaSession

            lastError = null
            ticker.syncTickingLocked()
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
            ticker.syncTickingLocked()
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
                ticker.syncTickingLocked()
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
            ticker.syncTickingLocked()
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
            ticker.syncTickingLocked()
        }
        startService(context)
        emitState()
    }

    fun pause(context: Context) {
        synchronized(lock) {
            ensure(context)
            pendingSeekState = null
            player?.pause()
            ticker.syncTickingLocked()
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
        val prefs = AudioResumeStore.progressPrefs(context.applicationContext)
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
            AudioResumeStore.progressPrefs(context.applicationContext).edit()
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

    // DrPlay fork: process-death resume snapshot (Bug 2). Persistence moved
    // to AudioResumeStore; this wrapper resolves the current QueueEntry from
    // the runtime playlist mirror (player index, then track-id match) and
    // forwards it with the last applied headers as plain parameters.
    internal fun persistResumeDataLocked(mediaItem: MediaItem?) {
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

        AudioResumeStore.persist(context = appContext ?: return, entry = entry, headers = lastAppliedHeaders)
    }

    fun dispose(context: Context) {
        synchronized(lock) {
            persistProgressCheckpointLocked(context.applicationContext, snapshotLocked(), force = true)
            ticker.stopLocked()

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
        AudioResumeStore.clear(context.applicationContext)
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

    internal fun emitState() {
        val snapshot = synchronized(lock) { snapshotLocked() }
        NativeAudioPlugin.emitToActive(snapshot)
    }

    internal fun persistProgressCheckpointLocked(context: Context, snapshot: NativeAudioState, force: Boolean) {
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

        AudioResumeStore.progressPrefs(context).edit()
            .putLong(PROGRESS_KEY_STORY_ID, storyId)
            .putFloat(PROGRESS_KEY_CURRENT_TIME, snapshot.currentTime.toFloat())
            .putLong(PROGRESS_KEY_UPDATED_AT_MS, now)
            .putString(PROGRESS_KEY_STATUS, snapshot.status)
            .apply()

        lastProgressPersistedAtMs = now
        lastProgressPersistedStoryId = storyId
        lastProgressPersistedTimeSec = snapshot.currentTime
    }

    internal fun snapshotLocked(): NativeAudioState {
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
