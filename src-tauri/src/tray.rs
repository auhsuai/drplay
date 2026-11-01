use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

pub static MINIMIZE_TO_TRAY: AtomicBool = AtomicBool::new(true);
pub static IS_QUITTING: AtomicBool = AtomicBool::new(false);

/// The two tray menu items, retained so their text can be changed after
/// creation (`MenuItem::set_text`).
///
/// The runtime is pinned to `tauri::Wry` because `MenuItem` has no default
/// type parameter (only the private `*Inner` structs get one via
/// `default_runtime`); this app only ever builds the wry runtime.
///
/// Deliberately a `static` and NOT managed `State`: `MenuItemInner::drop` calls
/// `run_on_main_thread` to free the native item, and once the event loop has
/// stopped that call fails, so the muda item would be dropped on the teardown
/// thread — running `RemoveWindowSubclass`/`RemoveMenu` against a window that
/// may already be gone. Leaking two handles at exit (the process is exiting
/// anyway) avoids that order entirely.
struct TrayMenuHandles {
    show: MenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
}
static TRAY_MENU: OnceLock<TrayMenuHandles> = OnceLock::new();

#[tauri::command]
pub fn update_minimize_to_tray(minimize: bool) {
    MINIMIZE_TO_TRAY.store(minimize, Ordering::SeqCst);
}

/// Retitles the tray popup entries. The frontend owns the translations
/// (`tray.show` / `tray.quit`), so the locale files stay the single source of
/// truth. Both labels are attempted even when the first one fails: a fully
/// English menu is better than a half-translated one, and the caller only needs
/// to know that the sync did not fully apply.
#[tauri::command]
pub fn set_tray_labels(show: String, quit: String) -> Result<(), String> {
    let Some(handles) = TRAY_MENU.get() else {
        let message = "tray menu handles not initialized".to_string();
        log::warn!("[tray] set_tray_labels skipped: {message}");
        return Err(message);
    };

    let show_error = handles.show.set_text(&show).err();
    let quit_error = handles.quit.set_text(&quit).err();

    if let Some(error) = &show_error {
        log::warn!("[tray] set_text(show) failed: {error}");
    }
    if let Some(error) = &quit_error {
        log::warn!("[tray] set_text(quit) failed: {error}");
    }

    match (show_error, quit_error) {
        (None, None) => Ok(()),
        (Some(error), _) => Err(format!("set tray show label failed: {error}")),
        (None, Some(error)) => Err(format!("set tray quit label failed: {error}")),
    }
}

/// Brings the main window back from the tray. `unminimize()` (SW_RESTORE)
/// must run BEFORE `show()`: `show()` is SW_SHOW and does not restore a
/// minimized window, and tao's `set_focus()` no-ops while the window is
/// minimized. Both tray entry points share this path.
pub(crate) fn restore_main_window(app: &tauri::AppHandle) {
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

    // Store the handles BEFORE `.build()`: the items are clones sharing the
    // same native item, so the labels set by the frontend later always land on
    // the menu the tray actually shows, and the defaults above are what a
    // frontend that never calls the command leaves in place.
    let _ = TRAY_MENU.set(TrayMenuHandles {
        show: show_i.clone(),
        quit: quit_i.clone(),
    });

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
