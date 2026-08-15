// DrPlay Task 4 mobile-polish (2026-08-15): SAF download folder picker +
// file writer for Android. tauri-plugin-dialog 2.7.1 has no Android folder
// picker (its Android arm only implements file/message dialogs), so this
// plugin drives the Storage Access Framework directly:
//   - pick_folder:  ACTION_OPEN_DOCUMENT_TREE + persistable URI permission.
//   - save_file:    streams a staged file (written by the frontend into
//                   app-private storage via plugin:fs|write_file) into the
//                   chosen SAF tree via DocumentFile + ContentResolver.
// The staged-file indirection exists because Kotlin plugin invokes are
// JSON-serialized (cannot carry multi-MB binaries efficiently), while the
// app's existing fs write path is proven on Android.
package app.tauri.safdownload

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.util.Log
import androidx.activity.result.ActivityResult
import androidx.documentfile.provider.DocumentFile
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

private const val TAG = "plugin/saf-download"

// Distinct reject codes the frontend maps to user-facing toasts:
//   cancelled                     — user dismissed the SAF picker
//   pick_failed:<detail>          — picker could not be launched / no URI
//   save_failed:staged_missing    — staged file absent/unreadable
//   save_failed:permission_denied — no write grant on the chosen tree
//   save_failed:create_failed     — provider refused to create the file
//   save_failed:open_output       — ContentResolver could not open the stream
//   save_failed:invalid_name      — file name rejected by the guard
//   save_failed:<detail>          — any other write error
private const val CODE_CANCELLED = "cancelled"
private const val CODE_PICK_FAILED = "pick_failed"
private const val CODE_SAVE_FAILED = "save_failed"
private const val CODE_SAVE_STAGED_MISSING = "save_failed:staged_missing"
private const val CODE_SAVE_PERMISSION_DENIED = "save_failed:permission_denied"
private const val CODE_SAVE_CREATE_FAILED = "save_failed:create_failed"
private const val CODE_SAVE_OPEN_OUTPUT = "save_failed:open_output"
private const val CODE_SAVE_INVALID_NAME = "save_failed:invalid_name"

// Read + write access is required for the whole subtree the user picks.
private const val URI_PERMISSION_FLAGS =
    Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION

private const val COPY_BUFFER_SIZE = 1 shl 16

@InvokeArg
class SaveFileArgs {
    lateinit var uri: String
    lateinit var fileName: String
    lateinit var stagedPath: String
}

@TauriPlugin
class SafDownloadPlugin(private val activity: Activity) : Plugin(activity) {

    // NOTE on naming: the JS/ACL side uses snake_case command names
    // (pick_folder / save_file in build.rs COMMANDS), but tauri converts the
    // command to lowerCamelCase before dispatching to Kotlin
    // (tauri-2.11.3 src/webview/mod.rs:1891 heck::AsLowerCamelCase), so the
    // Kotlin method names below are camelCase.
    @Command
    fun pickFolder(invoke: Invoke) {
        try {
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
                addFlags(
                    Intent.FLAG_GRANT_READ_URI_PERMISSION or
                        Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                        Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or
                        Intent.FLAG_GRANT_PREFIX_URI_PERMISSION
                )
            }
            startActivityForResult(invoke, intent, "pickFolderResult")
        } catch (ex: Exception) {
            Log.e(TAG, "pick_folder failed", ex)
            invoke.reject("$CODE_PICK_FAILED:${ex.message ?: "unknown"}")
        }
    }

    @ActivityCallback
    fun pickFolderResult(invoke: Invoke, result: ActivityResult) {
        try {
            when (result.resultCode) {
                Activity.RESULT_OK -> {
                    val uri = result.data?.data
                    if (uri == null) {
                        invoke.reject("$CODE_PICK_FAILED:no_uri")
                        return
                    }
                    // Persist the grant so downloads keep working after the
                    // process restarts (SAF docs: takePersistableUriPermission
                    // must be called while the grant is still active).
                    try {
                        activity.contentResolver.takePersistableUriPermission(
                            uri,
                            URI_PERMISSION_FLAGS,
                        )
                    } catch (sec: SecurityException) {
                        // Provider refused to persist (rare) — the app can
                        // still use the URI for this process lifetime.
                        Log.w(TAG, "takePersistableUriPermission failed: ${sec.message}")
                    }
                    val doc = DocumentFile.fromTreeUri(activity, uri)
                    val name = doc?.name
                        ?: DocumentsContract.getTreeDocumentId(uri)
                            .substringAfterLast(':')
                            .ifBlank { "Downloads" }
                    val ret = JSObject()
                    ret.put("uri", uri.toString())
                    ret.put("name", name)
                    invoke.resolve(ret)
                }
                Activity.RESULT_CANCELED -> invoke.reject(CODE_CANCELLED)
                else -> invoke.reject("$CODE_PICK_FAILED:result_${result.resultCode}")
            }
        } catch (ex: Exception) {
            Log.e(TAG, "pickFolderResult failed", ex)
            invoke.reject("$CODE_PICK_FAILED:${ex.message ?: "unknown"}")
        }
    }

    @Command
    fun saveFile(invoke: Invoke) {
        val args = invoke.parseArgs(SaveFileArgs::class.java)
        val safeName = sanitizeFileName(args.fileName)
        if (safeName == null) {
            invoke.reject(CODE_SAVE_INVALID_NAME)
            return
        }
        val staged = File(args.stagedPath)
        // The stream copy can take seconds for large files — never block the
        // Android main thread (plugin commands run there, Tauri docs).
        Thread {
            try {
                if (!staged.isFile || !staged.canRead()) {
                    Log.w(TAG, "staged file missing: ${staged.path}")
                    rejectOnMainThread(invoke, CODE_SAVE_STAGED_MISSING)
                    return@Thread
                }
                val treeUri = Uri.parse(args.uri)
                val tree = DocumentFile.fromTreeUri(activity, treeUri)
                if (tree == null || !tree.canWrite()) {
                    Log.w(TAG, "no write permission on tree $treeUri")
                    rejectOnMainThread(invoke, CODE_SAVE_PERMISSION_DENIED)
                    return@Thread
                }
                // Overwrite semantics: the frontend re-downloads the same
                // title into the same folder — replace the previous file.
                tree.findFile(safeName)?.delete()
                // Some providers reject a generic MIME; audio/* first, then
                // the universal */* fallback before giving up.
                val target = tree.createFile("audio/*", safeName)
                    ?: tree.createFile("*/*", safeName)
                if (target == null) {
                    Log.w(TAG, "provider refused to create $safeName in $treeUri")
                    rejectOnMainThread(invoke, CODE_SAVE_CREATE_FAILED)
                    return@Thread
                }
                val output = activity.contentResolver.openOutputStream(target.uri, "w")
                if (output == null) {
                    target.delete()
                    rejectOnMainThread(invoke, CODE_SAVE_OPEN_OUTPUT)
                    return@Thread
                }
                output.use { out ->
                    staged.inputStream().use { input ->
                        val buffer = ByteArray(COPY_BUFFER_SIZE)
                        while (true) {
                            val read = input.read(buffer)
                            if (read < 0) break
                            out.write(buffer, 0, read)
                        }
                    }
                }
                Log.i(TAG, "saved '$safeName' to $treeUri (${staged.length()} bytes)")
                val ret = JSObject()
                ret.put("saved", true)
                ret.put("name", safeName)
                resolveOnMainThread(invoke, ret)
            } catch (ex: Exception) {
                Log.e(TAG, "save_file failed", ex)
                rejectOnMainThread(invoke, "$CODE_SAVE_FAILED:${ex.message ?: "unknown"}")
            } finally {
                // The staged copy must never survive a failed/successful save.
                try {
                    if (staged.exists() && !staged.delete()) {
                        Log.w(TAG, "staged file delete failed: ${staged.path}")
                    }
                } catch (delEx: Exception) {
                    Log.w(TAG, "staged file delete threw: ${delEx.message}")
                }
            }
        }.start()
    }

    private fun resolveOnMainThread(invoke: Invoke, ret: JSObject) {
        activity.runOnUiThread { invoke.resolve(ret) }
    }

    private fun rejectOnMainThread(invoke: Invoke, message: String) {
        activity.runOnUiThread { invoke.reject(message) }
    }

    private fun sanitizeFileName(raw: String): String? {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return null
        if (trimmed.contains('/') || trimmed.contains('\\')) return null
        return trimmed
    }
}
