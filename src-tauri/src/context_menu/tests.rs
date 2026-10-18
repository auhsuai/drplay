use super::*;

fn item(id: &str, children: Option<Vec<MenuEntry>>) -> MenuEntry {
    MenuEntry::Item {
        id: id.to_string(),
        label: id.to_string(),
        shortcut: None,
        enabled: true,
        checked: false,
        children,
    }
}

#[test]
fn menu_entries_deserialize_with_defaults_and_recursive_children() {
    let json = r#"[
        {"kind":"separator"},
        {"kind":"item","id":"play","label":"Play / Pause","shortcut":"Space"},
        {"kind":"item","id":"audio","label":"Audio","children":[
            {"kind":"separator"},
            {"kind":"item","id":"volume","label":"Volume"}
        ]}
    ]"#;
    let parsed: Vec<MenuEntry> = serde_json::from_str(json).expect("menu JSON must deserialize");

    assert!(matches!(&parsed[0], MenuEntry::Separator));
    match &parsed[1] {
        MenuEntry::Item { id, label, shortcut, enabled, checked, children } => {
            assert_eq!(id, "play");
            assert_eq!(label, "Play / Pause");
            assert_eq!(shortcut.as_deref(), Some("Space"));
            assert!(*enabled, "enabled defaults to true");
            assert!(!*checked, "checked defaults to false");
            assert!(children.is_none());
        }
        other => panic!("expected an item, got {other:?}"),
    }
    match &parsed[2] {
        MenuEntry::Item { children, .. } => {
            let kids = children.as_ref().expect("children must parse");
            assert!(matches!(kids[0], MenuEntry::Separator));
            match &kids[1] {
                MenuEntry::Item { id, .. } => assert_eq!(id, "volume"),
                other => panic!("expected a nested item, got {other:?}"),
            }
        }
        other => panic!("expected an item, got {other:?}"),
    }
}

#[test]
fn menu_label_appends_the_shortcut_after_a_tab() {
    assert_eq!(menu_label("Play / Pause", Some("Space")), "Play / Pause\tSpace");
    assert_eq!(menu_label("Play / Pause", None), "Play / Pause");
    assert_eq!(menu_label("Play / Pause", Some("")), "Play / Pause", "an empty shortcut is no shortcut");
}

#[test]
fn leaf_items_receive_sequential_command_ids() {
    let entries = vec![
        MenuEntry::Separator,
        item("play", None),
        item("audio", Some(vec![MenuEntry::Separator, item("volume", None)])),
    ];
    let mut next = FIRST_COMMAND_ID;
    let mut steps = Vec::new();
    let map = assign_command_ids(&entries, &mut next, &mut steps);

    assert_eq!(map.get(&1).map(String::as_str), Some("play"));
    assert_eq!(map.get(&2).map(String::as_str), Some("volume"), "children of a submenu are assigned too");
    assert_eq!(next, 3, "two leaves consumed ids 1 and 2");
    assert!(
        !map.values().any(|item_id| item_id == "audio"),
        "a submenu parent is not selectable and must get no id"
    );

    let leaf_ids: Vec<u16> = steps
        .iter()
        .filter_map(|step| match step {
            MenuStep::Leaf { command_id, .. } => Some(*command_id),
            _ => None,
        })
        .collect();
    assert_eq!(leaf_ids, vec![1, 2], "separators are skipped, leaves keep append order");
}

#[test]
fn item_flags_combine_enabled_and_checked_independently() {
    assert_eq!(item_flags(true, false), MF_STRING);
    assert_eq!(item_flags(true, true), MF_STRING | MF_CHECKED);
    assert_eq!(item_flags(false, false), MF_STRING | MF_GRAYED);
    assert_eq!(item_flags(false, true), MF_STRING | MF_CHECKED | MF_GRAYED);
}

#[test]
fn build_menu_maps_the_plan_onto_a_real_hmenu() {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetMenuItemCount, GetMenuState, MF_BYPOSITION};

    let entries = vec![
        item("play", None),
        MenuEntry::Separator,
        MenuEntry::Item {
            id: "audio".to_string(),
            label: "Audio".to_string(),
            shortcut: None,
            enabled: false,
            checked: true,
            children: Some(vec![item("volume", None)]),
        },
    ];
    let (hmenu, map) = build_menu(&entries).expect("build_menu must succeed");

    // SAFETY: `hmenu` was just created by build_menu and not yet destroyed.
    let count = unsafe { GetMenuItemCount(hmenu) };
    assert_eq!(count, 3, "play, separator, audio (submenu)");
    // SAFETY: same live menu; index 2 is the submenu parent.
    let state = unsafe { GetMenuState(hmenu, 2, MF_BYPOSITION) };
    assert_ne!(state & MF_GRAYED, 0, "the disabled parent stays greyed");
    assert_eq!(map.len(), 2, "two leaves: play + volume");

    // SAFETY: destroys the tree, submenus included; called once.
    unsafe { DestroyMenu(hmenu) };
}
