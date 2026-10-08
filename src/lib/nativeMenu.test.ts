import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeMenuEntry } from "./nativeMenu";

const tauriMocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriMocks.invoke }));

import { showContextMenu } from "./nativeMenu";

const menu: NativeMenuEntry[] = [
  { kind: "separator" },
  { kind: "item", id: "PLAYER_MUTE", label: "Mute", shortcut: "M" },
];

beforeEach(() => {
  tauriMocks.invoke.mockReset();
});

describe("showContextMenu", () => {
  it("invokes show_context_menu with the tree and the requested screen coords", async () => {
    tauriMocks.invoke.mockResolvedValue("PLAYER_MUTE");

    const selected = await showContextMenu(menu, { x: 640, y: 480 });

    expect(tauriMocks.invoke).toHaveBeenCalledWith("show_context_menu", {
      menu,
      x: 640,
      y: 480,
    });
    expect(selected).toBe("PLAYER_MUTE");
  });

  it("passes null through (dismissed menu)", async () => {
    tauriMocks.invoke.mockResolvedValue(null);
    expect(await showContextMenu(menu)).toBe(null);
  });

  it("omits x/y keys entirely when no position is given (cursor fallback in Rust)", async () => {
    tauriMocks.invoke.mockResolvedValue(null);

    await showContextMenu(menu);

    const args = tauriMocks.invoke.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(Object.keys(args)).toEqual(["menu"]);
  });

  it("wraps a backend failure with the native menu context", async () => {
    tauriMocks.invoke.mockRejectedValue(new Error("win32 boom"));

    await expect(showContextMenu(menu, { x: 1, y: 2 })).rejects.toThrow(
      /native menu.*win32 boom/,
    );
  });
});
