package app.tauri.nativeaudio

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

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
