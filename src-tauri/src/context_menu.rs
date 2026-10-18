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

use std::collections::HashMap;

use windows_sys::Win32::Foundation::{GetLastError, HWND, POINT};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    AppendMenuW, CreatePopupMenu, DestroyMenu, GetCursorPos, HMENU, PostMessageW,
    SetForegroundWindow, TrackPopupMenu, MF_CHECKED, MF_GRAYED, MF_POPUP, MF_SEPARATOR,
    MF_STRING, TPM_LEFTBUTTON, TPM_NONOTIFY, TPM_RETURNCMD, WM_NULL,
};

use crate::video_host::wide;

/// Command ids start at 1: `TrackPopupMenu` reserves 0 for "dismissed".
const FIRST_COMMAND_ID: u16 = 1;

/// A u16 command-id space holds this many selectable items; more cannot be
/// represented as menu ids and is rejected before the build.
const MAX_MENU_ENTRIES: u16 = u16::MAX;

/// One entry of the menu tree, deserialized from the frontend payload.
#[derive(serde::Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum MenuEntry {
    Separator,
    Item {
        id: String,
        label: String,
        #[serde(default)]
        shortcut: Option<String>,
        #[serde(default = "default_enabled")]
        enabled: bool,
        #[serde(default)]
        checked: bool,
        #[serde(default)]
        children: Option<Vec<MenuEntry>>,
    },
}

/// An item without an explicit `enabled` is clickable.
fn default_enabled() -> bool {
    true
}

/// One step of the flat append plan, in execution order. `build_menu` only
/// executes the plan `assign_command_ids` produces, so the ids carried by the
/// real `HMENU` cannot drift from the id map.
#[derive(Debug)]
enum MenuStep {
    /// `CreatePopupMenu` + start filling the new submenu.
    OpenSubmenu,
    /// Close the current submenu: `AppendMenuW(MF_POPUP | flags, submenu,
    /// label)` onto the parent menu that is open below it.
    CloseSubmenu { label: String, flags: u32 },
    /// `AppendMenuW(MF_SEPARATOR, 0, NULL)`.
    Separator,
    /// A selectable item: `AppendMenuW(flags, command_id, label)`.
    Leaf {
        command_id: u16,
        flags: u32,
        label: String,
    },
}

/// The Win32 label of one item: the visible text, plus the shortcut after a
/// TAB when there is one — Windows right-aligns whatever follows the TAB.
/// An empty shortcut is no shortcut.
fn menu_label(label: &str, shortcut: Option<&str>) -> String {
    match shortcut.filter(|shortcut| !shortcut.is_empty()) {
        Some(shortcut) => format!("{label}\t{shortcut}"),
        None => label.to_string(),
    }
}

/// The item flags of a selectable entry: `MF_STRING` always, plus
/// `MF_CHECKED`/`MF_GRAYED` independently, so a checked+disabled item keeps
/// both bits.
fn item_flags(enabled: bool, checked: bool) -> u32 {
    let mut flags = MF_STRING;
    if checked {
        flags |= MF_CHECKED;
    }
    if !enabled {
        flags |= MF_GRAYED;
    }
    flags
}

/// Walk the tree in append order, flattening it into `steps` and assigning
/// sequential command ids to every LEAF item (an item without a non-empty
/// submenu). A submenu parent is not selectable, so it gets no id — but it
/// keeps its own enabled/checked flags on the `MF_POPUP` append. Returns the
/// `command id -> item id` map; `next` is left as the next free id.
fn assign_command_ids(
    entries: &[MenuEntry],
    next: &mut u16,
    steps: &mut Vec<MenuStep>,
) -> HashMap<u16, String> {
    let mut map = HashMap::new();
    plan_entries(entries, next, steps, &mut map);
    map
}

/// The recursion behind `assign_command_ids`.
fn plan_entries(
    entries: &[MenuEntry],
    next: &mut u16,
    steps: &mut Vec<MenuStep>,
    map: &mut HashMap<u16, String>,
) {
    for entry in entries {
        match entry {
            MenuEntry::Separator => steps.push(MenuStep::Separator),
            MenuEntry::Item { id, label, shortcut, enabled, checked, children } => {
                let display = menu_label(label, shortcut.as_deref());
                match children.as_deref().filter(|kids| !kids.is_empty()) {
                    Some(kids) => {
                        steps.push(MenuStep::OpenSubmenu);
                        plan_entries(kids, next, steps, map);
                        steps.push(MenuStep::CloseSubmenu {
                            label: display,
                            flags: item_flags(*enabled, *checked),
                        });
                    }
                    None => {
                        let command_id = *next;
                        // A u16 id space holds 65535 leaves; `build_menu`
                        // rejects over-long input before planning, so this
                        // cannot wrap for any menu that can be built.
                        *next = next.wrapping_add(1);
                        map.insert(command_id, id.clone());
                        steps.push(MenuStep::Leaf {
                            command_id,
                            flags: item_flags(*enabled, *checked),
                            label: display,
                        });
                    }
                }
            }
        }
    }
}

/// One `AppendMenuW` against the menu currently being filled; a `None` label
/// is the NULL a separator takes.
fn append_menu(parent: HMENU, flags: u32, item: usize, label: Option<&str>) -> Result<(), String> {
    let wide_label = label.map(wide);
    let pointer = wide_label.as_ref().map_or(std::ptr::null(), |label| label.as_ptr());
    // SAFETY: `parent` is a live menu created by this module; `pointer` is
    // either NULL (separators) or a NUL-terminated buffer that outlives the
    // call — AppendMenuW copies it.
    let appended = unsafe { AppendMenuW(parent, flags, item, pointer) };
    if appended == 0 {
        // SAFETY: reading this thread's last-error value; no preconditions.
        let error = unsafe { GetLastError() };
        return Err(format!("context menu: AppendMenuW failed (win32 error {error})"));
    }
    Ok(())
}

/// Execute the append plan against real menus; returns the root menu and the
/// command-id map. On every failure path each created menu is destroyed, so
/// no HMENU leaks (a root menu's destroy releases its submenus).
fn build_menu(entries: &[MenuEntry]) -> Result<(HMENU, HashMap<u16, String>), String> {
    if entries.len() > MAX_MENU_ENTRIES as usize {
        return Err(format!(
            "context menu: {} entries cannot be represented (limit {MAX_MENU_ENTRIES})",
            entries.len()
        ));
    }
    let mut steps = Vec::new();
    let mut next = FIRST_COMMAND_ID;
    let map = assign_command_ids(entries, &mut next, &mut steps);

    // SAFETY: CreatePopupMenu is a plain menu factory; the null return is
    // checked below.
    let root = unsafe { CreatePopupMenu() };
    if root.is_null() {
        // SAFETY: reading this thread's last-error value; no preconditions.
        let error = unsafe { GetLastError() };
        return Err(format!("context menu: CreatePopupMenu failed (win32 error {error})"));
    }
    // Every menu still being filled, root first. A submenu leaves this stack
    // when it attaches to its parent, so no open menu owns another one.
    let mut open: Vec<HMENU> = vec![root];

    for step in &steps {
        let outcome = match step {
            MenuStep::OpenSubmenu => {
                // SAFETY: same factory call as above; the null return is
                // checked.
                let submenu = unsafe { CreatePopupMenu() };
                if submenu.is_null() {
                    // SAFETY: reading this thread's last-error value.
                    let error = unsafe { GetLastError() };
                    Err(format!("context menu: CreatePopupMenu failed (win32 error {error})"))
                } else {
                    open.push(submenu);
                    Ok(())
                }
            }
            MenuStep::CloseSubmenu { label, flags } => {
                let submenu = open.pop();
                match (submenu, open.last().copied()) {
                    (Some(submenu), Some(parent)) => match append_menu(parent, MF_POPUP | *flags, submenu as usize, Some(label.as_str())) {
                        Ok(()) => Ok(()),
                        Err(append_error) => {
                            // It never attached: keep it open so the shared
                            // cleanup below releases it too.
                            open.push(submenu);
                            Err(append_error)
                        }
                    },
                    (submenu, _) => {
                        if let Some(submenu) = submenu {
                            open.push(submenu);
                        }
                        Err("context menu: internal error: no parent menu is open".to_string())
                    }
                }
            }
            MenuStep::Separator => match open.last().copied() {
                Some(parent) => append_menu(parent, MF_SEPARATOR, 0, None),
                None => Err("context menu: internal error: separator outside a menu".to_string()),
            },
            MenuStep::Leaf { command_id, flags, label } => match open.last().copied() {
                Some(parent) => append_menu(parent, *flags, *command_id as usize, Some(label.as_str())),
                None => Err("context menu: internal error: item outside a menu".to_string()),
            },
        };
        if let Err(step_error) = outcome {
            // Deepest first: no open menu is attached to another one, and the
            // submenus that DID attach go down with the open parent above
            // them.
            for handle in open.iter().rev() {
                // SAFETY: every handle was created above and is not reused.
                unsafe { DestroyMenu(*handle) };
            }
            return Err(step_error);
        }
    }

    if open.len() != 1 {
        for handle in open.iter().rev() {
            // SAFETY: as in the failure path above.
            unsafe { DestroyMenu(*handle) };
        }
        return Err("context menu: internal error: unbalanced submenu plan".to_string());
    }
    Ok((root, map))
}

/// Show the menu and resolve with the selected command id; `None` means the
/// user dismissed it. `x`/`y` are SCREEN coordinates (both must be present,
/// otherwise the current cursor position is used).
fn track_popup(owner: HWND, hmenu: HMENU, x: Option<i32>, y: Option<i32>) -> Result<Option<u16>, String> {
    // A foreground owner is what makes the menu dismiss on an outside click
    // (documented TrackPopupMenu requirement). Failure is not fatal: the menu
    // still opens, it can just outlive the first outside click.
    // SAFETY: `owner` is a live window; the call has no other requirement.
    if unsafe { SetForegroundWindow(owner) } == 0 {
        // SAFETY: reading this thread's last-error value; no preconditions.
        let error = unsafe { GetLastError() };
        log::warn!("context menu: SetForegroundWindow({}) failed (win32 error {error})", owner as usize);
    }
    let (x, y) = match (x, y) {
        (Some(x), Some(y)) => (x, y),
        _ => {
            let mut cursor = POINT { x: 0, y: 0 };
            // SAFETY: `cursor` is a live local POINT.
            if unsafe { GetCursorPos(&mut cursor) } == 0 {
                // SAFETY: reading this thread's last-error value.
                let error = unsafe { GetLastError() };
                return Err(format!("context menu: GetCursorPos failed (win32 error {error})"));
            }
            (cursor.x, cursor.y)
        }
    };
    // SAFETY: `owner` is a live window owned by the calling thread (the main
    // thread), `hmenu` is the live root menu, and a null prcRect is
    // documented as ignored.
    let selected = unsafe {
        TrackPopupMenu(hmenu, TPM_RETURNCMD | TPM_NONOTIFY | TPM_LEFTBUTTON, x, y, 0, owner, std::ptr::null())
    };
    // Documented Win32 quirk: post a harmless message so the menu's modal
    // loop cannot leave the owner in the stale "menu active" state.
    // SAFETY: `owner` is the same live window.
    if unsafe { PostMessageW(owner, WM_NULL, 0, 0) } == 0 {
        // SAFETY: reading this thread's last-error value.
        let error = unsafe { GetLastError() };
        log::warn!("context menu: PostMessageW(WM_NULL) failed (win32 error {error})");
    }
    // With TPM_RETURNCMD the return value is the selected item id; 0 means
    // the menu was dismissed (an error is indistinguishable from a dismissal
    // under this flag).
    if selected == 0 {
        return Ok(None);
    }
    u16::try_from(selected)
        .map(Some)
        .map_err(|_| format!("context menu: TrackPopupMenu returned an out-of-range id {selected}"))
}

/// The whole blocking Win32 part, meant to run on the thread that owns
/// `owner`: build the menu, track it, destroy it, and map the selection back
/// to the frontend `id`.
fn show_menu_blocking(
    owner: usize,
    menu: &[MenuEntry],
    x: Option<i32>,
    y: Option<i32>,
) -> Result<Option<String>, String> {
    let owner = owner as HWND;
    let (hmenu, command_ids) = build_menu(menu)?;
    let selection = track_popup(owner, hmenu, x, y);
    // Destroy the whole tree on every path below; attached submenus go with
    // the root.
    // SAFETY: `hmenu` is the live root menu created above, not used again.
    if unsafe { DestroyMenu(hmenu) } == 0 {
        // SAFETY: reading this thread's last-error value.
        let error = unsafe { GetLastError() };
        log::warn!("context menu: DestroyMenu failed (win32 error {error})");
    }
    match selection? {
        None => Ok(None),
        Some(command_id) => command_ids
            .get(&command_id)
            .cloned()
            .map(Some)
            .ok_or_else(|| format!("context menu: TrackPopupMenu selected an unknown command id {command_id}")),
    }
}

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
