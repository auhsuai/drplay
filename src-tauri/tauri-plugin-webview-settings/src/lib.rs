// Android-only plugin: locks the system WebView's textZoom to 100 so the OS
// font-scale accessibility setting cannot inflate DrPlay's px-sized player
// UI (Android WebView applies fontScale as a percentage text zoom by
// default, which breaks fixed layouts on large-font devices). All behavior
// lives in the Kotlin class (WebviewSettingsPlugin.load); this crate only
// registers it — a desktop no-op, mirroring tauri-plugin-saf-download.
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "app.tauri.webviewsettings";

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("webview-settings")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                let _ = _api.register_android_plugin(
                    PLUGIN_IDENTIFIER,
                    "WebviewSettingsPlugin",
                )?;
            }
            Ok(())
        })
        .build()
}
