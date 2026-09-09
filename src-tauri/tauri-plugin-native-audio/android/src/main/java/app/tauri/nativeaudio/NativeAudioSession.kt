package app.tauri.nativeaudio

import android.app.PendingIntent
import android.content.Context
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.session.MediaSession
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture

internal class BuiltAudioSession(
    val player: ExoPlayer,
    val mediaSessionPlayer: Player,
    val mediaSession: MediaSession,
)

// DrPlay fork: process-death resumption hook (Bug 2). media3 1.4.1 puts
// onPlaybackResumption on MediaSession.Callback — NOT on MediaSessionService
// (verified against MediaSessionService.java / MediaSession.java at tag
// 1.4.1) — so it is attached to the session builder in ensure(). Returning
// a failed future when nothing is persisted mirrors the default
// implementation (immediateFailedFuture(UnsupportedOperationException)).
// Pure data work only (prefs read + object build), no player access.
@OptIn(UnstableApi::class)
internal val resumptionSessionCallback = object : MediaSession.Callback {
    override fun onPlaybackResumption(
        mediaSession: MediaSession,
        controller: MediaSession.ControllerInfo,
    ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
        val context = NativeAudioRuntime.appContext
        if (context == null) {
            Log.w(TAG, "onPlaybackResumption: runtime not initialized, cannot resume")
            return Futures.immediateFailedFuture(
                IllegalStateException("native audio runtime not initialized")
            )
        }
        val data = AudioResumeStore.resumptionSnapshot(context)
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
        NativeAudioRuntime.httpDataSourceFactory.setDefaultRequestProperties(data.headers ?: emptyMap())
        val mediaItem = buildMediaItem(data.src, data.title, data.artist, data.artworkUrl, data.trackId)
        return Futures.immediateFuture(
            MediaSession.MediaItemsWithStartPosition(
                listOf(mediaItem), 0, (data.positionSec * 1000.0).toLong(),
            )
        )
    }
}

@OptIn(UnstableApi::class)
internal fun buildAudioSession(
    context: Context,
    dataSourceFactory: DefaultHttpDataSource.Factory,
    onRecoveryPlay: () -> Unit,
): BuiltAudioSession {
    val audioAttributes = AudioAttributes.Builder()
        .setUsage(C.USAGE_MEDIA)
        .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
        .build()

    val exoPlayer = ExoPlayer.Builder(context)
        .setSeekBackIncrementMs(SEEK_INCREMENT_MS)
        .setSeekForwardIncrementMs(SEEK_INCREMENT_MS)
        .setMediaSourceFactory(
            DefaultMediaSourceFactory(dataSourceFactory, DefaultExtractorsFactory())
        )
        .build()
    exoPlayer.setAudioAttributes(audioAttributes, true)
    exoPlayer.setHandleAudioBecomingNoisy(true)
    exoPlayer.setWakeMode(C.WAKE_MODE_LOCAL)

    val mediaSessionPlayer = object : ForwardingPlayer(exoPlayer) {
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
            onRecoveryPlay()
        }
    }

    val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
    val pendingIntent = launchIntent?.let {
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or
            (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)
        PendingIntent.getActivity(context, 0, it, flags)
    }

    val sessionPlayer = mediaSessionPlayer
    val mediaSession = MediaSession.Builder(context, sessionPlayer)
        .apply {
            if (pendingIntent != null) setSessionActivity(pendingIntent)
            setCallback(resumptionSessionCallback)
        }
        .build()

    return BuiltAudioSession(
        player = exoPlayer,
        mediaSessionPlayer = mediaSessionPlayer,
        mediaSession = mediaSession,
    )
}

internal fun buildMediaItem(
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
