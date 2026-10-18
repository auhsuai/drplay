//! Native Win32 context menu for the embedded video surface.
//!
//! The frontend owns the menu CONTENT (labels, shortcuts, enabled/checked
//! state, nesting) and sends it as JSON; this module owns the Win32 part:
//! building an `HMENU` from the tree, tracking it with `TrackPopupMenu`, and
//! reporting the selected item's `id` back (or `None` when dismissed).
//!
//! Threading: `TrackPopupMenu` must run on the thread that owns the owner
//! window, so the async command hops to the main thread through
//! `run_on_main_thread` and hands the result back via a oneshot channel.

mod model;
mod win32;

pub use model::MenuEntry;
use win32::show_menu_blocking;

#[cfg(test)]
use model::{assign_command_ids, item_flags, menu_label, MenuStep, FIRST_COMMAND_ID};
#[cfg(test)]
use win32::build_menu;
#[cfg(test)]
use windows_sys::Win32::UI::WindowsAndMessaging::{DestroyMenu, MF_CHECKED, MF_GRAYED, MF_STRING};

/// Show the native context menu and resolve with the selected item's `id`
/// (`None` when the menu was dismissed). Runs the blocking Win32 menu loop on
/// the main thread — the thread that owns the invoking window.
#[tauri::command]
pub async fn show_context_menu(
    app: tauri::AppHandle,
    window: tauri::Window,
    menu: Vec<MenuEntry>,
    x: Option<i32>,
    y: Option<i32>,
) -> Result<Option<String>, String> {
    let (result_tx, result_rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let result = window
            .hwnd()
            .map_err(|hwnd_error| format!("context menu: cannot resolve the invoking window HWND: {hwnd_error}"))
            .and_then(|hwnd| show_menu_blocking(hwnd.0 as usize, &menu, x, y));
        // The command future may have been cancelled; nothing to do then.
        let _ = result_tx.send(result);
    })
    .map_err(|thread_error| format!("context menu: run_on_main_thread failed: {thread_error}"))?;
    result_rx
        .await
        .map_err(|recv_error| format!("context menu: main thread never delivered a result: {recv_error}"))?
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests;
