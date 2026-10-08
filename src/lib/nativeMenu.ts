import { invoke } from "@tauri-apps/api/core";
import { describeError } from "./mpvProtocol";

/**
 * Frontend half of the native Win32 context menu (src-tauri/src/context_menu.rs).
 * The tree is JSON; Rust builds the HMENU and resolves with the selected item's
 * `id` (null when the user dismisses it). Same IPC tier/pattern as videoHost.ts:
 * one Tauri command name, one typed wrapper, one place that wraps failures.
 */

export interface NativeMenuSeparator {
  kind: "separator";
}

export interface NativeMenuItem {
  kind: "item";
  id: string;
  label: string;
  shortcut?: string;
  enabled?: boolean;
  checked?: boolean;
  children?: NativeMenuEntry[];
}

export type NativeMenuEntry = NativeMenuSeparator | NativeMenuItem;

/** Physical SCREEN coordinates for the popup anchor (Windows pixel space). */
export interface NativeMenuPosition {
  x: number;
  y: number;
}

const SHOW_CONTEXT_MENU_COMMAND = "show_context_menu";

/**
 * Show the native menu and resolve with the selected item id (`null` when
 * dismissed). `at` omitted => Rust anchors the menu at the current cursor
 * position, so the x/y keys are left out entirely rather than sent as null.
 */
export async function showContextMenu(
  entries: NativeMenuEntry[],
  at?: NativeMenuPosition,
): Promise<string | null> {
  try {
    const selected = await invoke<unknown>(SHOW_CONTEXT_MENU_COMMAND, {
      menu: entries,
      ...(at !== undefined ? { x: at.x, y: at.y } : {}),
    });
    return typeof selected === "string" ? selected : null;
  } catch (e: unknown) {
    throw new Error(`native menu: ${describeError(e)}`);
  }
}
