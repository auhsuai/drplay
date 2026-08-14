#![cfg(desktop)]
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
                app.exit(0);
            }
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                    crate::memory::apply_window_activity(&window, crate::memory::WindowActivityEvent::ShownFromTray);
                }
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
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                    crate::memory::apply_window_activity(&window, crate::memory::WindowActivityEvent::ShownFromTray);
                }
            }
        })
        .build(app)?;

    Ok(())
}
