package app.tauri.nativeaudio

import android.app.ActivityManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.PowerManager

// DrPlay fork: progress ticker extracted from NativeAudioRuntime (move-only).
// Shares the runtime's single lock — every synchronized block below locks
// runtime.lock, no new lock is introduced.
internal class PlaybackTicker(private val runtime: NativeAudioRuntime) {
    private val tickHandler = Handler(Looper.getMainLooper())
    private var tickScheduled = false

    val tickRunnable = object : Runnable {
        override fun run() {
            val shouldContinue = synchronized(runtime.lock) {
                val snapshot = runtime.snapshotLocked()
                runtime.appContext?.let { runtime.persistProgressCheckpointLocked(it, snapshot, force = false) }
                NativeAudioPlugin.emitToActive(snapshot)
                val isPlaying = runtime.player?.isPlaying == true
                tickScheduled = isPlaying
                isPlaying
            }
            if (shouldContinue) {
                val delay = synchronized(runtime.lock) { nextProgressTickDelayLocked() }
                tickHandler.postDelayed(this, delay)
            }
        }
    }

    fun syncTicking() {
        synchronized(runtime.lock) {
            syncTickingLocked()
        }
    }

    fun syncTickingLocked() {
        val isPlaying = runtime.player?.isPlaying == true
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

    fun stopLocked() {
        tickHandler.removeCallbacks(tickRunnable)
        tickScheduled = false
    }

    private fun nextProgressTickDelayLocked(): Long {
        val context = runtime.appContext ?: return BACKGROUND_PROGRESS_TICK_MS
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
}
