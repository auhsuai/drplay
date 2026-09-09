package app.tauri.nativeaudio

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import org.json.JSONObject

// DrPlay fork: resume-snapshot persistence (Bug 2), extracted from
// NativeAudioRuntime. Receives all data through parameters — it does not
// read Runtime state. Shares the progress prefs file (single accessor,
// also used by the runtime checkpoint flow) and the story-id checkpoint
// position value (PROGRESS_KEY_CURRENT_TIME) as the resumption position.
internal object AudioResumeStore {
    fun progressPrefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PROGRESS_PREFS_NAME, Context.MODE_PRIVATE)

    fun persist(
        context: Context,
        entry: QueueEntry,
        headers: Map<String, String>?,
    ) {
        progressPrefs(context).edit()
            .putString(RESUME_KEY_SRC, entry.src)
            .putString(RESUME_KEY_TITLE, entry.title)
            .putString(RESUME_KEY_ARTIST, entry.artist)
            .putString(RESUME_KEY_ARTWORK, entry.artworkUrl)
            .putString(RESUME_KEY_HEADERS_JSON, encodeHeaders(headers))
            .putString(RESUME_KEY_TRACK_ID, entry.trackId)
            .apply()
    }

    fun clear(context: Context) {
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
    fun encodeHeaders(headers: Map<String, String>?): String? {
        if (headers.isNullOrEmpty()) return null
        return runCatching { JSONObject(headers).toString() }
            .onFailure { error ->
                Log.w(TAG, "encodeHeaders failed for ${headers.size} headers", error)
            }
            .getOrNull()
    }

    fun decodeHeaders(json: String?): Map<String, String>? {
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
}
