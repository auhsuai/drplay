// No IPC commands — this plugin only mutates WebView settings via the
// Android lifecycle hook (see src/lib.rs + WebviewSettingsPlugin.kt).
const COMMANDS: &[&str] = &[];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
