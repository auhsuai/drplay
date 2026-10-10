// @vitest-environment jsdom
/**
 * RED tests for the DrPlay-rendered video menu. ONE renderer serves both entry
 * points (More button / right-click); only the anchor differs. The native
 * Win32 popup and any Tauri invoke must be unreachable from this component.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeMenuEntry } from "../../../lib/nativeMenu";
import en from "../../../locales/en/translation.json";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
const nativeMenuMock = vi.hoisted(() => ({ showContextMenu: vi.fn() }));
vi.mock("../../../lib/nativeMenu", () => nativeMenuMock);
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { VideoMenu } from "./VideoMenu";

const RECT: DOMRect = {
  top: 700,
  right: 1280,
  bottom: 740,
  left: 1240,
  x: 1240,
  y: 700,
  width: 40,
  height: 40,
  toJSON: () => ({}),
};

const ENTRIES: NativeMenuEntry[] = [
  { kind: "item", id: "PLAYER_PLAY_PAUSE", label: "Play" },
  { kind: "item", id: "PLAYER_MUTE", label: "Mute", checked: true },
  {
    kind: "item",
    id: "menu:crop",
    label: "Crop",
    enabled: false,
    children: [
      { kind: "item", id: "menu:crop:none", label: "None", checked: true },
      { kind: "item", id: "menu:crop:16/9", label: "16:9" },
    ],
  },
  { kind: "separator" },
  {
    kind: "item",
    id: "menu:audio",
    label: "Audio",
    children: [
      { kind: "item", id: "menu:audio:no", label: "No audio" },
      { kind: "item", id: "menu:audio:1", label: "Commentary" },
    ],
  },
];

function renderMenu(over: Partial<Parameters<typeof VideoMenu>[0]> = {}) {
  const props = {
    isOpen: true,
    entries: ENTRIES,
    anchorPoint: { x: 100, y: 100 } as { x: number; y: number } | null,
    buttonRect: null,
    onSelect: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  return { props, ...render(<VideoMenu {...props} />) };
}

function rootMenu(): HTMLElement {
  const menus = document.body.querySelectorAll<HTMLElement>('[role="menu"]');
  const root = Array.from(menus).find((m) => m.dataset.submenu !== "true");
  if (!root) throw new Error("video menu not rendered");
  return root;
}

/**
 * Every row of a panel. Checkable rows are `menuitemcheckbox` (APG: aria-checked
 * is only valid there), so both roles are collected — the same selector the
 * shared roving-focus helper uses.
 */
function rows(menu: HTMLElement): HTMLElement[] {
  return Array.from(
    menu.querySelectorAll<HTMLElement>(
      '[role="menuitem"],[role="menuitemcheckbox"]',
    ),
  );
}

function itemLabels(menu: HTMLElement): string[] {
  return rows(menu).map((el) => el.textContent?.trim() ?? "");
}

function rowByLabel(menu: HTMLElement, name: RegExp): HTMLElement {
  const found = rows(menu).find((el) => name.test(el.textContent ?? ""));
  if (!found) throw new Error(`no row matching ${String(name)}`);
  return found;
}

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
  nativeMenuMock.showContextMenu.mockReset();
});

describe("VideoMenu rendering (DrPlay design system)", () => {
  it("portals a role=menu with the DrPlay panel styling and no trigger button", () => {
    const { container } = renderMenu();

    const menu = rootMenu();
    expect(menu.className).toContain("bg-white");
    expect(menu.className).toContain("dark:bg-[#2a2b2f]");
    expect(menu.className).toContain("rounded-xl");
    expect(menu.className).toContain("w-60");
    // The trigger belongs to the video bar; the menu renders no trigger of its
    // own (MoreMenu's own trigger would add a second ⋯ button here).
    expect(container.querySelector("button")).toBeNull();
    expect(document.body.querySelector(".lucide-ellipsis")).toBeNull();
    expect(
      document.body.querySelector('[aria-label="common.more_actions"]'),
    ).toBeNull();
  });

  it("renders every entry with its label and marks separators", () => {
    renderMenu();

    const menu = rootMenu();
    expect(itemLabels(menu)).toEqual(["Play", "Mute", "Crop", "Audio"]);
    expect(within(menu).getAllByRole("separator")).toHaveLength(1);
  });

  it("renders a checked state as a checkmark icon, not just a data attribute", () => {
    renderMenu();

    const menu = rootMenu();
    // Checked rows show the checkmark in the leading slot (the native menu's
    // check column) AND announce it, so the state is not colour/icon-only.
    const mute = rowByLabel(menu, /Mute/);
    expect(mute.querySelector(".lucide-check")).not.toBeNull();
    expect(mute).toHaveAttribute("aria-checked", "true");
    // A row with no `checked` value is not checkable at all: plain role, no
    // aria-checked (the attribute is only valid on menuitemcheckbox).
    const play = rowByLabel(menu, /Play/);
    expect(play.querySelector(".lucide-check")).toBeNull();
    expect(play).not.toHaveAttribute("aria-checked");
  });

  it("maps ids and prefixes to distinct DrPlay icons with a sane default", () => {
    renderMenu();

    const menu = rootMenu();
    const iconOf = (name: RegExp) =>
      rowByLabel(menu, name).querySelector("svg")?.getAttribute("class");
    // Mute is checked in the fixture, so its leading slot is the checkmark;
    // Play (a PLAYER_* command id) and Audio (a section id) are not.
    expect(iconOf(/Play/)).toContain("lucide-play");
    expect(iconOf(/Audio/)).toContain("lucide-volume-2");
  });

  it("falls back to a default icon for an id the map does not know", () => {
    renderMenu({
      entries: [{ kind: "item", id: "menu:brand-new", label: "Brand new" }],
    });

    const icon = rowByLabel(rootMenu(), /Brand new/).querySelector("svg");
    // The default keeps the leading slot occupied (never a blank row).
    expect(icon).not.toBeNull();
  });

  it("renders a disabled entry as aria-disabled and never activates it", () => {
    const { props } = renderMenu();

    const crop = rowByLabel(rootMenu(), /Crop/);
    expect(crop).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(crop);

    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("never calls the native menu or any Tauri invoke", () => {
    const { props } = renderMenu();

    fireEvent.click(rowByLabel(rootMenu(), /Play/));
    fireEvent.contextMenu(rootMenu());

    expect(nativeMenuMock.showContextMenu).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(props.onSelect).toHaveBeenCalledWith("PLAYER_PLAY_PAUSE");
  });
});

describe("VideoMenu submenus (DrPlay style, APG)", () => {
  it("a parent entry exposes haspopup/expanded and opens a nested DrPlay panel", () => {
    renderMenu();

    const audio = rowByLabel(rootMenu(), /Audio/);
    expect(audio).toHaveAttribute("aria-haspopup", "menu");
    expect(audio).toHaveAttribute("aria-expanded", "false");
    expect(
      document.querySelector('[role="menu"][data-submenu="true"]'),
    ).toBeNull();

    fireEvent.click(audio);

    expect(audio).toHaveAttribute("aria-expanded", "true");
    const submenu = document.querySelector<HTMLElement>(
      '[role="menu"][data-submenu="true"]',
    );
    expect(submenu).not.toBeNull();
    expect(submenu?.className).toContain("bg-white");
    expect(submenu?.className).toContain("dark:bg-[#2a2b2f]");
    expect(submenu?.className).toContain("rounded-xl");
    expect(itemLabels(submenu as HTMLElement)).toEqual([
      "No audio",
      "Commentary",
    ]);
  });

  it("picking a nested entry dispatches its own id exactly once", () => {
    const { props } = renderMenu();

    fireEvent.click(rowByLabel(rootMenu(), /Audio/));
    const submenu = document.querySelector<HTMLElement>(
      '[role="menu"][data-submenu="true"]',
    );
    fireEvent.click(rowByLabel(submenu as HTMLElement, /Commentary/));

    expect(props.onSelect).toHaveBeenCalledTimes(1);
    expect(props.onSelect).toHaveBeenCalledWith("menu:audio:1");
    // Closing is the OWNER's job (useVideoMenu.select closes first, then
    // dispatches), so the renderer never closes a menu behind the owner's back.
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("the second Escape closes the submenu first, the next closes the menu (APG order)", () => {
    const { props } = renderMenu();

    const audio = rowByLabel(rootMenu(), /Audio/);
    fireEvent.click(audio);
    const submenu = document.querySelector<HTMLElement>(
      '[role="menu"][data-submenu="true"]',
    ) as HTMLElement;

    fireEvent.keyDown(rowByLabel(submenu, /No audio/), {
      key: "Escape",
    });
    expect(
      document.querySelector('[role="menu"][data-submenu="true"]'),
    ).toBeNull();
    expect(props.onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(audio);

    fireEvent.keyDown(audio, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("ArrowRight opens the focused submenu, ArrowLeft closes it", () => {
    renderMenu();

    const audio = rowByLabel(rootMenu(), /Audio/);
    audio.focus();
    fireEvent.keyDown(audio, { key: "ArrowRight" });
    expect(
      document.querySelector('[role="menu"][data-submenu="true"]'),
    ).not.toBeNull();

    fireEvent.keyDown(audio, { key: "ArrowLeft" });
    expect(
      document.querySelector('[role="menu"][data-submenu="true"]'),
    ).toBeNull();
  });
});

describe("VideoMenu keyboard + dismissal", () => {
  it("focuses the first item on open and roves with Arrow/Home/End", () => {
    renderMenu();

    const items = rows(rootMenu());
    expect(document.activeElement).toBe(items[0]);
    expect(items[0]?.tabIndex).toBe(0);
    expect(items[1]?.tabIndex).toBe(-1);

    fireEvent.keyDown(items[0] as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1] as HTMLElement, { key: "End" });
    expect(document.activeElement).toBe(items[items.length - 1]);
    fireEvent.keyDown(items[items.length - 1] as HTMLElement, { key: "Home" });
    expect(document.activeElement).toBe(items[0]);
  });

  it("roving skips the disabled entry", () => {
    renderMenu();

    const items = rows(rootMenu());
    const disabledIndex = items.findIndex(
      (el) => el.getAttribute("aria-disabled") === "true",
    );
    expect(disabledIndex).toBeGreaterThan(0);
    fireEvent.keyDown(items[disabledIndex - 1] as HTMLElement, {
      key: "ArrowDown",
    });
    expect(document.activeElement).toBe(items[disabledIndex + 1]);
  });

  it("Escape on the document closes the menu (and blocks the browser menu)", () => {
    const { props } = renderMenu();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("an outside mousedown closes the menu; a click inside does not", () => {
    const { props } = renderMenu();

    fireEvent.mouseDown(rowByLabel(rootMenu(), /Play/));
    expect(props.onClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(document.body);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("a right-click inside the open menu is swallowed, never a second menu", () => {
    const { props } = renderMenu();

    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    rootMenu().dispatchEvent(event);
    fireEvent.keyDown(document, { key: "Escape" });

    expect(event.defaultPrevented).toBe(true);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("renders nothing at all while closed", () => {
    const { container } = renderMenu({ isOpen: false });

    expect(container.innerHTML).toBe("");
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
  });
});

describe("VideoMenu positioning", () => {
  const originalVw = window.innerWidth;
  const originalVh = window.innerHeight;

  function setViewport(vw: number, vh: number): void {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: vw,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: vh,
    });
  }

  afterEach(() => {
    setViewport(originalVw, originalVh);
  });

  it("a point anchor positions at the pointer", () => {
    setViewport(1280, 800);
    renderMenu({ anchorPoint: { x: 100, y: 100 } });

    const menu = rootMenu();
    expect(menu.style.left).toBe("100px");
    expect(menu.style.top).toBe("100px");
  });

  it("a button anchor positions against the trigger rect", () => {
    setViewport(1280, 800);
    renderMenu({ anchorPoint: null, buttonRect: RECT });

    const menu = rootMenu();
    // Right-aligned to the trigger (which touches the right edge here) and
    // opened upwards, 8px above it — the bar's More button lives at the bottom.
    expect(menu.style.right).toBe("0px");
    expect(menu.style.bottom).toBe("108px");
  });

  it("clamps inside a small viewport instead of spilling off-screen", () => {
    setViewport(360, 640);
    renderMenu({ anchorPoint: { x: 350, y: 630 } });

    const menu = rootMenu();
    // The 240px panel is wider than the space right of the pointer, so the
    // shared positioning utility shifts it back inside instead of clipping.
    expect(menu.style.right).toBe("10px");
    expect(menu.style.left).toBe("");
    expect(menu.style.bottom).toBe("10px");
    expect(menu.style.top).toBe("");
  });

  it("clamps at the opposite corner too (pointer near the left/top edge)", () => {
    setViewport(300, 200);
    renderMenu({ anchorPoint: { x: 0, y: 0 } });

    const menu = rootMenu();
    expect(menu.style.left).toBe("0px");
    expect(menu.style.top).toBe("0px");
  });
});

describe("VideoMenu i18n label", () => {
  it("names the menu for assistive tech through the i18n key", () => {
    // The stub returns the key, which proves the lookup goes through
    // react-i18next with the locale key (and not a hard-coded string).
    renderMenu();

    expect(screen.getByRole("menu", { name: "player.menu.video_menu" })).toBe(
      rootMenu(),
    );
    expect(en.player.menu.video_menu).toBeTruthy();
  });
});
