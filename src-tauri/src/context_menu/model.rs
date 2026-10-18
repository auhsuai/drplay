//! Pure menu model: the frontend payload tree and the flat append plan.

use std::collections::HashMap;

use windows_sys::Win32::UI::WindowsAndMessaging::{MF_CHECKED, MF_GRAYED, MF_STRING};

/// Command ids start at 1: `TrackPopupMenu` reserves 0 for "dismissed".
pub(super) const FIRST_COMMAND_ID: u16 = 1;

/// A u16 command-id space holds this many selectable items; more cannot be
/// represented as menu ids and is rejected before the build.
pub(super) const MAX_MENU_ENTRIES: u16 = u16::MAX;

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
pub(super) enum MenuStep {
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
pub(super) fn menu_label(label: &str, shortcut: Option<&str>) -> String {
    match shortcut.filter(|shortcut| !shortcut.is_empty()) {
        Some(shortcut) => format!("{label}\t{shortcut}"),
        None => label.to_string(),
    }
}

/// The item flags of a selectable entry: `MF_STRING` always, plus
/// `MF_CHECKED`/`MF_GRAYED` independently, so a checked+disabled item keeps
/// both bits.
pub(super) fn item_flags(enabled: bool, checked: bool) -> u32 {
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
pub(super) fn assign_command_ids(
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
