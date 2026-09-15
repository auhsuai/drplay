use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

pub static MINIMIZE_TO_TRAY: AtomicBool = AtomicBool::new(true);
pub static IS_QUITTING: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub fn update_minimize_to_tray(minimize: bool) {
    MINIMIZE_TO_TRAY.store(minimize, Ordering::SeqCst);
}

/// Brings the main window back from the tray. `unminimize()` (SW_RESTORE)
/// must run BEFORE `show()`: `show()` is SW_SHOW and does not restore a
/// minimized window, and tao's `set_focus()` no-ops while the window is
/// minimized. Both tray entry points share this path.
fn restore_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        crate::memory::apply_window_activity(&window, crate::memory::WindowActivityEvent::ShownFromTray);
    }
}

pub fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let show_i = MenuItem::with_id(app, "show", "Show DrPlay", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

    let icon = app.default_window_icon().cloned();
    let mut tray = TrayIconBuilder::new()
        .menu(&menu)
        .show_menu_on_left_click(false);
    
    if let Some(icon) = icon {
        tray = tray.icon(icon);
    }

    let _tray = tray
        .on_menu_event(|app, event| match event.id.as_ref() {
            "quit" => {
                IS_QUITTING.store(true, Ordering::SeqCst);
                // Best-effort sync kill before exit: the async mpv_shutdown
                // cannot run here, and the Job Object (the real guarantee)
                // reaps anything this misses at handle teardown.
                #[cfg(windows)]
                crate::mpv::mpv_kill_sync_best_effort(app);
                app.exit(0);
            }
            "show" => {
                restore_main_window(app);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                restore_main_window(app);
            }
        })
        .build(app)?;

    Ok(())
}
