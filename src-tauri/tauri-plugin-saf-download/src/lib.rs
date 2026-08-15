// Android-only plugin: Storage Access Framework folder picker + file writer
// (ACTION_OPEN_DOCUMENT_TREE + takePersistableUriPermission + DocumentFile).
// DrPlay Task 4 mobile-polish — replaces the unsupported tauri-plugin-dialog
// folder picker on Android (dialog 2.7.1 has no Android folder support).
// All behavior lives in the Kotlin class; this crate only registers it.
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "app.tauri.safdownload";

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("saf-download")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                let _ = _api.register_android_plugin(PLUGIN_IDENTIFIER, "SafDownloadPlugin")?;
            }
            Ok(())
        })
        .build()
}
