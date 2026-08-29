package app.tauri.nativeaudio

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.graphics.Bitmap
import android.os.Build
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.ui.PlayerNotificationManager

private const val NOTIFICATION_ID = 9501
private const val CHANNEL_ID_SUFFIX = ".native_audio"
private const val NOTIFICATION_ICON_NAME = "ic_notification"

class NativeAudioService : MediaSessionService() {
    private var notificationManager: PlayerNotificationManager? = null

    override fun onCreate() {
        super.onCreate()
        NativeAudioRuntime.ensure(applicationContext)
        setupNotificationManager()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? {
        return NativeAudioRuntime.mediaSession()
    }

    override fun onUpdateNotification(session: MediaSession, startInForegroundRequired: Boolean) {
        // PlayerNotificationManager is the single source for media controls in notification shade.
        // Retry setup if the service started before the runtime session was ready (the manager
        // is created lazily in onCreate and can miss the window on slow/cold starts).
        if (notificationManager == null) setupNotificationManager()
    }

    override fun onDestroy() {
        notificationManager?.setPlayer(null)
        notificationManager = null
        super.onDestroy()
    }

    private fun setupNotificationManager() {
        val player = NativeAudioRuntime.mediaSessionPlayer() ?: return
        val mediaSession = NativeAudioRuntime.mediaSession() ?: return
        if (notificationManager != null) return

        ensureNotificationChannel()

        notificationManager = PlayerNotificationManager.Builder(this, NOTIFICATION_ID, channelId())
            .setMediaDescriptionAdapter(
                object : PlayerNotificationManager.MediaDescriptionAdapter {
                    override fun getCurrentContentTitle(player: androidx.media3.common.Player): CharSequence {
                        return player.mediaMetadata.title ?: appDisplayName()
                    }

                    override fun createCurrentContentIntent(player: androidx.media3.common.Player): PendingIntent? {
                        return mediaSession.sessionActivity
                    }

                    override fun getCurrentContentText(player: androidx.media3.common.Player): CharSequence? {
                        return player.mediaMetadata.artist
                    }

                    override fun getCurrentLargeIcon(
                        player: androidx.media3.common.Player,
                        callback: PlayerNotificationManager.BitmapCallback,
                    ): Bitmap? {
                        return null
                    }
                },
            )
            .setNotificationListener(
                object : PlayerNotificationManager.NotificationListener {
                    override fun onNotificationPosted(notificationId: Int, notification: Notification, ongoing: Boolean) {
                        if (ongoing) {
                            startForeground(notificationId, notification)
                        } else {
                            stopForegroundCompat(remove = false)
                        }
                    }

                    override fun onNotificationCancelled(notificationId: Int, dismissedByUser: Boolean) {
                        stopForegroundCompat(remove = true)
                        stopSelf()
                    }
                },
            )
            .build()
            .apply {
                setMediaSessionToken(mediaSession.platformToken)
                // Standard media controls (YT Music/Spotify layout): prev +
                // play/pause + next. Play/pause icon follows player state
                // automatically; rewind/fast-forward are app-internal and not
                // part of the notification contract.
                setUsePlayPauseActions(true)
                setUsePreviousAction(true)
                setUseNextAction(true)
                setUseFastForwardAction(false)
                setUseRewindAction(false)
                // Compact (collapsed) row shows play/pause + next; prev stays
                // in the expanded view.
                setUsePreviousActionInCompactView(false)
                setUseNextActionInCompactView(true)
                setUseRewindActionInCompactView(false)
                setUseFastForwardActionInCompactView(false)
                setUseStopAction(false)
                setSmallIcon(resolveNotificationSmallIconResId())
                // Accent color for the media notification: media3 defaults to
                // colorized=true with a transparent color, which leaves the action
                // buttons tinted system-gray. Value mirrors src/App.css
                // --color-brand-primary (Context#getColor, API 23+; minSdk is 26).
                setColor(getColor(R.color.brand_primary))
                setPlayer(player)
            }
    }

    private fun channelId(): String {
        return "${packageName}${CHANNEL_ID_SUFFIX}"
    }

    private fun appDisplayName(): String {
        return applicationInfo.loadLabel(packageManager)?.toString().orEmpty().ifBlank { "Audio app" }
    }

    private fun resolveNotificationSmallIconResId(): Int {
        val notificationIcon = resources.getIdentifier(NOTIFICATION_ICON_NAME, "drawable", packageName)
        if (notificationIcon != 0) return notificationIcon
        return android.R.drawable.ic_media_play
    }

    private fun stopForegroundCompat(remove: Boolean) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(if (remove) Service.STOP_FOREGROUND_REMOVE else Service.STOP_FOREGROUND_DETACH)
            return
        }
        @Suppress("DEPRECATION")
        stopForeground(remove)
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(channelId()) != null) return
        val channel = NotificationChannel(channelId(), appDisplayName(), NotificationManager.IMPORTANCE_LOW).apply {
            description = "Audio playback controls"
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }
}
