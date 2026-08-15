const COMMANDS: &[&str] = &["pick_folder", "save_file"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
