package app.tauri.nativeaudio

import android.util.Log
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player

// DrPlay fork: Player.Listener extracted from NativeAudioRuntime (move-only).
// Reads and mutates runtime state through internal members and always locks
// runtime.lock — no new lock is introduced.
internal class NativePlayerListener(private val runtime: NativeAudioRuntime) : Player.Listener {
    override fun onPlaybackStateChanged(playbackState: Int) {
        if (playbackState == Player.STATE_ENDED) {
            synchronized(runtime.lock) {
                runtime.appContext?.let { runtime.persistProgressCheckpointLocked(it, runtime.snapshotLocked(), force = true) }
            }
        }
        runtime.ticker.syncTicking()
        runtime.emitState()
    }

    override fun onIsPlayingChanged(isPlaying: Boolean) {
        runtime.ticker.syncTicking()
        runtime.emitState()
    }

    // DrPlay fork: with a queue, ExoPlayer advances to the next item
    // NATIVELY on STATE_ENDED — no WebView round-trip needed (Bug 3: a
    // backgrounded WebView gets suspended and the JS-driven advance
    // never runs). The listener also keeps the progress checkpoint and
    // the process-death resume snapshot in sync with the new item.
    override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
        synchronized(runtime.lock) {
            // Track the item id as a raw string (Drive file ids are not
            // numeric); setMediaId on queue items keeps this non-empty,
            // while setSource items keep the default "" and are ignored.
            val id = mediaItem?.mediaId?.takeIf { it.isNotEmpty() }
            if (id != null) runtime.currentMediaId = id
            runtime.appContext?.let { runtime.persistProgressCheckpointLocked(it, runtime.snapshotLocked(), force = true) }
            runtime.persistResumeDataLocked(mediaItem)
        }
        runtime.ticker.syncTicking()
        runtime.emitState()
    }

    // DrPlay fork: the buffer bar must also grow while PAUSED. The 25ms
    // progress tick only runs while isPlaying, and Media3 has no event
    // dedicated to buffered-position changes — EVENT_IS_LOADING_CHANGED
    // is the closest signal (Player.java). Each emitState ships a fresh
    // getBufferedPosition() estimate; the JS bridge diffs values before
    // surfacing "progress", so unchanged pushes are free.
    override fun onIsLoadingChanged(isLoading: Boolean) {
        runtime.ticker.syncTicking()
        runtime.emitState()
    }

    override fun onPlaybackParametersChanged(playbackParameters: androidx.media3.common.PlaybackParameters) {
        runtime.emitState()
    }

    override fun onPositionDiscontinuity(
        oldPosition: Player.PositionInfo,
        newPosition: Player.PositionInfo,
        reason: Int,
    ) {
        if (reason == Player.DISCONTINUITY_REASON_SEEK || reason == Player.DISCONTINUITY_REASON_SEEK_ADJUSTMENT) {
            synchronized(runtime.lock) {
                val exoPlayer = runtime.player ?: return@synchronized
                val pendingSeek = runtime.pendingSeekState
                val shouldResume = pendingSeek?.shouldResume ?: exoPlayer.playWhenReady
                if (!shouldResume && exoPlayer.playWhenReady) exoPlayer.pause()
                val shouldRecoverPlayback =
                    shouldResume &&
                        !exoPlayer.isPlaying &&
                        exoPlayer.playbackState == Player.STATE_READY &&
                        runtime.lastError == null
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
                    runtime.pendingSeekState = null
                    Log.i(TAG, "seek landed, cleared pendingSeekState shouldResume=$shouldResume")
                }
                runtime.appContext?.let { runtime.persistProgressCheckpointLocked(it, runtime.snapshotLocked(), force = true) }
            }
        }
        runtime.ticker.syncTicking()
        runtime.emitState()
    }

    override fun onPlayerError(error: PlaybackException) {
        Log.e(TAG, "onPlayerError code=${error.errorCodeName} message=${error.message}", error)
        synchronized(runtime.lock) {
            // DrPlay fork: forward the real error code name (e.g.
            // ERROR_CODE_PARSER_CONTAINER_UNSUPPORTED / ERROR_CODE_IO_*)
            // instead of a bare message so the JS side can tell a
            // container/seek failure (m4a moov-at-end) apart from a
            // network or decoder one. The JS still maps every error to
            // code "format_error" — only the diagnostics text changes.
            runtime.lastError = "${error.errorCodeName}: ${error.message ?: "unknown"}"
            runtime.pendingSeekState = null
        }
        runtime.ticker.syncTicking()
        runtime.emitState()
    }
}
