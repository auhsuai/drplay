// DrPlay Android WebView settings lock: the OS font-scale accessibility
// setting is applied by the system WebView as a percentage text zoom, which
// inflates every px-sized element in DrPlay's fixed player layout on
// large-font devices. Pinning textZoom to 100 neutralizes that inflation
// (the app renders its own accessible sizes). Registered from Rust via
// register_android_plugin — no IPC commands, only the load(webView)
// lifecycle hook.
package app.tauri.webviewsettings

import android.app.Activity
import android.webkit.WebView
import app.tauri.plugin.Plugin

private const val TEXT_ZOOM_LOCKED = 100

class WebviewSettingsPlugin(private val activity: Activity) : Plugin(activity) {

    override fun load(webView: WebView) {
        super.load(webView)
        webView.settings.textZoom = TEXT_ZOOM_LOCKED
    }
}
