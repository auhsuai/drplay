// @vitest-environment jsdom
/**
 * RED tests for the DrPlay-rendered video menu. ONE renderer serves both entry
 * points (More button / right-click); only the anchor differs. The native
 * Win32 popup and any Tauri invoke must be unreachable from this component.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
import { MENU_ITEM_BASE_CLASS } from "./constants";
import { MENU_IDS } from "../../../player/menuModel";

/**
 * jsdom implements no matchMedia, so the video menu reads it once to decide
 * whether hover may open a flyout. `hover: true` = a pointer device (hover
 * opens submenus), `false` = touch / hoverless input (click only).
 */
function stubPointer(hover: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: hover,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

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
 * is only valid there), so both roles are collected � the same selector the
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

/**
 * The `relative` wrapper that holds a parent row TOGETHER WITH its flyout � the
 * hover boundary. React builds onMouseEnter/onMouseLeave from mouseover/mouseout
 * (a raw `mouseenter` event never reaches the handler), so the tests drive the
 * bubbling pair instead.
 */
function hoverArea(row: HTMLElement): HTMLElement {
  const wrapper = row.parentElement;
  if (!wrapper) throw new Error("row is not wrapped");
  return wrapper;
}

function flyouts(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '[role="menu"][data-submenu="true"]',
    ),
  );
}

/** A three-level tree (audio > audio track > tracks) plus a sibling parent. */
const NESTED_ENTRIES: NativeMenuEntry[] = [
  {
    kind: "item",
    id: "menu:audio",
    label: "Audio",
    children: [
      {
        kind: "item",
        id: "menu:audio:track",
        label: "Audio track",
        children: [
          { kind: "item", id: "menu:audio:track:1", label: "Track one" },
          { kind: "item", id: "menu:audio:track:2", label: "Track two" },
        ],
      },
      { kind: "item", id: "menu:audio:delay", label: "Delay" },
    ],
  },
  {
    kind: "item",
    id: "menu:video",
    label: "Video",
    children: [{ kind: "item", id: "menu:video:track", label: "Video track" }],
  },
];

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
  nativeMenuMock.showContextMenu.mockReset();
});

/**
 * jsdom implements no scrollIntoView (it exists in every real browser). The menu
 * calls it to centre the playing track in the queue box, so give it a no-op
 * unless a test replaces it with a spy.
 */
beforeEach(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: () => {},
  });
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
    // own (MoreMenu's own trigger would add a second ? button here).
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

  it("gives the PiP row its own glyph, not the default circle", () => {
    // The row's id is the MENU-owned `menu:pip`, not the PLAYER_PIP_TOGGLE
    // command id: mapping only the command left this row on the default
    // `Circle`, which reads as an empty bullet next to real icons.
    renderMenu({
      entries: [
        { kind: "item", id: MENU_IDS.pip, label: "Picture in Picture" },
      ],
    });

    const icon = rowByLabel(rootMenu(), /Picture in Picture/).querySelector(
      "svg",
    );
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("class")).toContain(
      "lucide-picture-in-picture-2",
    );
    expect(icon?.getAttribute("class")).not.toContain("lucide-circle");
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

  it("positions the flyout against its row (absolute), never the viewport (fixed)", () => {
    renderMenu();

    // Only ONE positioning utility may live in a panel's class: `fixed` and
    // `absolute` are the same specificity, so whichever Tailwind emits later in
    // the stylesheet wins. Merged into one constant, `fixed` won on the flyout
    // � which then had no inline style, so `left-full`/`right-full` resolved
    // against the VIEWPORT and pushed the whole submenu off-screen.
    const root = rootMenu();
    expect(root.className).toContain("fixed");
    expect(root.className).not.toContain("absolute");

    fireEvent.click(rowByLabel(root, /Audio/));
    const submenu = document.querySelector<HTMLElement>(
      '[role="menu"][data-submenu="true"]',
    );
    expect(submenu).not.toBeNull();
    // The flyout must anchor to its `relative` row (VideoMenu.tsx wraps each
    // parent in one), which is what makes it place itself beside the row
    // instead of at the viewport edge.
    expect(submenu?.className).toContain("absolute");
    expect(submenu?.className).not.toContain("fixed");
    // ...and the placement itself is MEASURED (inline), not declared by a
    // class, so it can react to the row's real position.
    expect(submenu?.style.top).not.toBe("");
    expect(submenu?.style.left).not.toBe("");
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

describe("VideoMenu row density (compact, video menu only)", () => {
  it("uses a tighter vertical rhythm than the shared menu row", () => {
    renderMenu();

    for (const row of rows(rootMenu())) {
      expect(row.className).toContain("py-1.5");
      expect(row.className).not.toContain("py-2");
      expect(row.className).toContain("mb-0.5");
    }
  });

  it("leaves the shared row class alone, so no other menu restyles", () => {
    renderMenu();

    // MENU_ITEM_BASE_CLASS still backs every OTHER menu (queue, playlist,
    // sidebar, player bar, recent) � it must keep its own rhythm.
    expect(MENU_ITEM_BASE_CLASS).toContain("py-2");
    expect(MENU_ITEM_BASE_CLASS).not.toContain("py-1.5");
  });

  it("keeps the compact row visually identical otherwise (theme, radius, hover)", () => {
    renderMenu();

    const row = rowByLabel(rootMenu(), /Play/);
    for (const token of [
      "rounded-md",
      "text-gray-700",
      "dark:text-gray-200",
      "hover:bg-gray-50",
      "dark:hover:bg-[#33343a]",
      "px-3",
      "text-sm",
      "gap-2",
    ]) {
      expect(MENU_ITEM_BASE_CLASS).toContain(token);
      expect(row.className).toContain(token);
    }
  });
});

describe("VideoMenu hover opens submenus (pointer devices)", () => {
  beforeEach(() => {
    stubPointer(true);
  });
  afterEach(() => {
    Reflect.deleteProperty(window, "matchMedia");
  });

  it("hovering a parent opens its submenu without a click", () => {
    renderMenu();

    const audio = rowByLabel(rootMenu(), /Audio/);
    expect(audio).toHaveAttribute("aria-expanded", "false");
    expect(flyouts()).toHaveLength(0);

    fireEvent.mouseOver(hoverArea(audio));

    expect(audio).toHaveAttribute("aria-expanded", "true");
    expect(flyouts()).toHaveLength(1);
    expect(itemLabels(flyouts()[0] as HTMLElement)).toEqual([
      "No audio",
      "Commentary",
    ]);
  });

  it("re-entering the already open parent leaves its submenu open (no toggle)", () => {
    renderMenu();

    const audio = rowByLabel(rootMenu(), /Audio/);
    fireEvent.mouseOver(hoverArea(audio));
    // A pointer drifting inside the same row re-enters the boundary.
    fireEvent.mouseOver(hoverArea(audio));
    fireEvent.mouseOver(hoverArea(audio));

    expect(audio).toHaveAttribute("aria-expanded", "true");
    expect(flyouts()).toHaveLength(1);
  });

  it("hovering a different parent swaps the open submenu", () => {
    renderMenu({ entries: NESTED_ENTRIES });

    const root = rootMenu();
    const audio = rowByLabel(root, /Audio/);
    const video = rowByLabel(root, /^Video$/);
    fireEvent.mouseOver(hoverArea(audio));
    expect(audio).toHaveAttribute("aria-expanded", "true");

    fireEvent.mouseOver(hoverArea(video));

    expect(audio).toHaveAttribute("aria-expanded", "false");
    expect(video).toHaveAttribute("aria-expanded", "true");
    // Exactly one flyout � the sibling was replaced, not stacked.
    expect(flyouts()).toHaveLength(1);
    expect(itemLabels(flyouts()[0] as HTMLElement)).toEqual(["Video track"]);
  });

  it("moving the pointer from the parent into its own submenu keeps it open", () => {
    renderMenu();

    const audio = rowByLabel(rootMenu(), /Audio/);
    fireEvent.mouseOver(hoverArea(audio));
    const flyout = flyouts()[0] as HTMLElement;

    // Enter the flyout the way a real pointer does: leave the row for a
    // descendant of the SAME wrapper (row + flyout are one hover area).
    fireEvent.mouseOut(rowByLabel(flyout, /No audio/), {
      relatedTarget: flyout,
    });
    fireEvent.mouseOver(flyout);

    expect(audio).toHaveAttribute("aria-expanded", "true");
    expect(flyouts()).toHaveLength(1);
  });

  it("opens every level of a nested tree and drops back to one on a sibling", () => {
    renderMenu({ entries: NESTED_ENTRIES });

    const root = rootMenu();
    fireEvent.mouseOver(hoverArea(rowByLabel(root, /Audio/)));
    const audioFlyout = flyouts()[0] as HTMLElement;
    expect(itemLabels(audioFlyout)).toEqual(["Audio track", "Delay"]);

    fireEvent.mouseOver(hoverArea(rowByLabel(audioFlyout, /Audio track/)));
    const trackFlyout = flyouts()[1] as HTMLElement;
    expect(trackFlyout).not.toBeUndefined();
    expect(itemLabels(trackFlyout)).toEqual(["Track one", "Track two"]);

    // The whole chain is still visible: root parent + both levels.
    expect(flyouts()).toHaveLength(2);

    fireEvent.mouseOver(hoverArea(rowByLabel(root, /^Video$/)));
    expect(flyouts()).toHaveLength(1);
    expect(itemLabels(flyouts()[0] as HTMLElement)).toEqual(["Video track"]);
  });

  it("hover never dispatches a command; only picking a child does, exactly once", () => {
    const { props } = renderMenu({ entries: NESTED_ENTRIES });

    const root = rootMenu();
    fireEvent.mouseOver(hoverArea(rowByLabel(root, /Audio/)));
    fireEvent.mouseOver(
      hoverArea(rowByLabel(flyouts()[0] as HTMLElement, /Audio track/)),
    );
    expect(props.onSelect).not.toHaveBeenCalled();

    fireEvent.click(rowByLabel(flyouts()[1] as HTMLElement, /Track two/));

    expect(props.onSelect).toHaveBeenCalledTimes(1);
    expect(props.onSelect).toHaveBeenCalledWith("menu:audio:track:2");
  });

  it("leaving the whole menu collapses every flyout instead of hanging one over the video", () => {
    vi.useFakeTimers();
    renderMenu({ entries: NESTED_ENTRIES });

    const root = rootMenu();
    fireEvent.mouseOver(hoverArea(rowByLabel(root, /Audio/)));
    fireEvent.mouseOver(
      hoverArea(rowByLabel(flyouts()[0] as HTMLElement, /Audio track/)),
    );
    expect(flyouts()).toHaveLength(2);

    fireEvent.mouseOut(rowByLabel(flyouts()[1] as HTMLElement, /Track one/), {
      relatedTarget: document.body,
    });

    // The collapse is delayed so a 12px gap does not close the submenu instantly.
    expect(flyouts()).toHaveLength(2);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(flyouts()).toHaveLength(0);
    expect(rowByLabel(root, /Audio/)).toHaveAttribute("aria-expanded", "false");
    // The menu itself survives � dismissal stays the outside-mousedown path's job.
    expect(document.body.contains(root)).toBe(true);
    vi.useRealTimers();
  });

  it("does not open the submenu of a disabled parent", () => {
    renderMenu();

    const crop = rowByLabel(rootMenu(), /Crop/);
    fireEvent.mouseOver(hoverArea(crop));

    expect(crop).toHaveAttribute("aria-expanded", "false");
    expect(flyouts()).toHaveLength(0);
  });

  it("moving from a parent onto a plain row closes its submenu (the reported bug)", () => {
    renderMenu({ entries: NESTED_ENTRIES });

    const root = rootMenu();
    fireEvent.mouseOver(hoverArea(rowByLabel(root, /Audio/)));
    fireEvent.mouseOver(
      hoverArea(rowByLabel(flyouts()[0] as HTMLElement, /Audio track/)),
    );
    expect(flyouts()).toHaveLength(2);

    // "Delay" is a LEAF inside the Audio flyout: only its own level collapses,
    // the Audio flyout itself stays.
    fireEvent.mouseOver(
      hoverArea(rowByLabel(flyouts()[0] as HTMLElement, /^Delay$/)),
    );
    expect(flyouts()).toHaveLength(1);
    expect(flyouts()[0]).toHaveAttribute("aria-label", "Audio");
  });

  it("crossing a root-level plain row collapses everything below it", () => {
    const { props } = renderMenu({
      entries: [
        {
          kind: "item",
          id: "menu:playlist",
          label: "Playlist",
          children: [{ kind: "item", id: "menu:queue:a", label: "One" }],
        },
        { kind: "item", id: "PLAYER_MEDIA_INFO", label: "Media info" },
      ],
    });

    const root = rootMenu();
    fireEvent.mouseOver(hoverArea(rowByLabel(root, /Playlist/)));
    expect(flyouts()).toHaveLength(1);

    // Playlist -> Media info: the flyout must not survive the crossing.
    fireEvent.mouseOver(hoverArea(rowByLabel(root, /^Media info$/)));

    expect(flyouts()).toHaveLength(0);
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("keeps a parent label beside its icon and pins only the chevron right", () => {
    renderMenu();

    const audio = rowByLabel(rootMenu(), /Audio/);
    // justify-between would push the label to the middle of the panel.
    expect(audio.className).not.toContain("justify-between");
    const chevron = audio.querySelector("svg.ml-auto");
    expect(chevron).not.toBeNull();
    expect(chevron).toHaveClass("ml-auto");
  });
});

describe("VideoMenu queue list is not a wall of repeated icons", () => {
  const QUEUE_ENTRIES: NativeMenuEntry[] = [
    {
      kind: "item",
      id: "menu:queue:one",
      label: "38. [AEQG][1080p] Dragon Ball",
    },
    {
      kind: "item",
      id: "menu:queue:two",
      label: "39. [AEQG][1080p] Dragon Ball Super",
    },
    {
      kind: "item",
      id: "PLAYER_QUEUE_TOGGLE",
      label: "Toggle queue",
    },
  ];

  it("hides the repeated glyph on a queue row but keeps the icon column", () => {
    renderMenu({ entries: QUEUE_ENTRIES });

    const menu = rootMenu();
    const one = rowByLabel(menu, /^38\./);
    const toggle = rowByLabel(menu, /Toggle queue/);
    // The glyph is present but invisible � no more 50 repeated ListMusic icons.
    const glyph = one.querySelector("svg");
    expect(glyph).not.toBeNull();
    expect(glyph).toHaveClass("opacity-0");
    // Sizing classes are unchanged, so the label sits in the same column as the
    // rows below that DO draw a glyph.
    expect(glyph?.getAttribute("class")).toContain("w-4");
    expect(glyph?.getAttribute("class")).toContain("h-4");
    // The neighbouring row keeps its visible icon.
    expect(toggle.querySelector("svg")).toHaveClass("opacity-60");
  });

  it("highlights the track that is playing instead of putting a checkmark on it", () => {
    renderMenu({
      entries: [
        { kind: "item", id: "menu:queue:one", label: "38. One" },
        {
          kind: "item",
          id: "menu:queue:two",
          label: "39. Two",
          checked: true,
        },
      ],
    });

    const menu = rootMenu();
    const current = rowByLabel(menu, /^39\./);
    // No checkmark anywhere on the row � the queue icon column stays blank.
    expect(current.querySelector(".lucide-check")).toBeNull();
    expect(current.querySelector("svg")).toHaveClass("opacity-0");
    // The brand highlight replaces it: blue text on a subtle blue wash.
    expect(current).toHaveClass("text-brand-text!");
    expect(current).toHaveClass("bg-brand-primary/10!");
    expect(current).toHaveClass("dark:bg-brand-primary/15!");
    expect(current).toHaveClass("hover:bg-brand-primary/20!");
    // Still announced to assistive tech: the state did not change, only how it
    // is drawn.
    expect(current).toHaveAttribute("aria-checked", "true");
    expect(current).toHaveAttribute("role", "menuitemcheckbox");
    // Other queue rows keep neither the highlight nor a check.
    const other = rowByLabel(menu, /^38\./);
    expect(other).not.toHaveClass("text-brand-text!");
    expect(other.querySelector(".lucide-check")).toBeNull();
  });

  it("keeps the checkmark on every checked row OUTSIDE the queue", () => {
    renderMenu({
      entries: [
        {
          kind: "item",
          id: "PLAYER_MUTE",
          label: "Mute",
          checked: true,
        },
        {
          kind: "item",
          id: "menu:audio",
          label: "Audio",
          checked: true,
          children: [{ kind: "item", id: "menu:audio:1", label: "Main" }],
        },
      ],
    });

    const menu = rootMenu();
    for (const label of [/Mute/, /Audio/]) {
      const row = rowByLabel(menu, label);
      expect(row.querySelector(".lucide-check")).not.toBeNull();
      expect(row).not.toHaveClass("text-brand-text!");
      expect(row).not.toHaveClass("bg-brand-primary/10!");
    }
  });

  it("leaves every other menu's icons untouched", () => {
    renderMenu();

    // The rows around the queue list keep their glyphs.
    const audio = rowByLabel(rootMenu(), /Audio/);
    expect(audio.querySelector(".lucide-volume-2")).not.toBeNull();
    expect(
      rowByLabel(rootMenu(), /Play/).querySelector(".lucide-play"),
    ).not.toBeNull();
  });

  it("moves the highlight when the playing track changes � it is never remembered", () => {
    const base = {
      isOpen: true,
      anchorPoint: { x: 100, y: 100 },
      buttonRect: null,
      onSelect: vi.fn(),
      onClose: vi.fn(),
    };
    const entries = (current: string): NativeMenuEntry[] => [
      {
        kind: "item",
        id: "menu:queue:a",
        label: "1. A",
        checked: current === "a",
      },
      {
        kind: "item",
        id: "menu:queue:b",
        label: "2. B",
        checked: current === "b",
      },
    ];
    // Re-rendering with a different currentTrackId is what a new menu snapshot
    // looks like; the highlight must follow it with no local state involved.
    const { rerender } = render(<VideoMenu {...base} entries={entries("a")} />);
    expect(rowByLabel(rootMenu(), /1\. A/)).toHaveClass("text-brand-text!");

    rerender(<VideoMenu {...base} entries={entries("b")} />);

    expect(rowByLabel(rootMenu(), /1\. A/)).not.toHaveClass("text-brand-text!");
    expect(rowByLabel(rootMenu(), /2\. B/)).toHaveClass("text-brand-text!");
  });

  it("keeps the playing track highlighted while the pointer is on another one", () => {
    stubPointer(true);
    try {
      renderMenu({
        entries: [
          { kind: "item", id: "menu:queue:a", label: "1. A" },
          { kind: "item", id: "menu:queue:b", label: "2. B", checked: true },
        ],
      });

      const menu = rootMenu();
      const current = rowByLabel(menu, /2\. B/);
      fireEvent.mouseOver(hoverArea(rowByLabel(menu, /1\. A/)));

      // Hover is a separate concern: the brand classes are unconditional, so
      // pointing at another row cannot strip the playing track's cue.
      expect(current).toHaveClass("text-brand-text!");
      expect(current).toHaveClass("bg-brand-primary/10!");
      // ...and the hovered row stays a plain hover row.
      expect(rowByLabel(menu, /1\. A/)).not.toHaveClass("bg-brand-primary/10!");
    } finally {
      Reflect.deleteProperty(window, "matchMedia");
    }
  });
});

/** Flyout panel size the positioning tests measure against (w-60, and tall). */
const PANEL_W = 240;
const PANEL_H = 200;

/**
 * jsdom implements no layout: `offsetParent` is always null and the offsets are
 * 0, so the flyout's own collision measurement could never run. They are
 * supplied file-wide � `offsetParent` is the `relative` wrapper, which is
 * exactly what it is for this panel � because correct placement is a core
 * behaviour, not something only the positioning tests may observe.
 */
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get(this: HTMLElement) {
      return this.parentElement;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => PANEL_H,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => PANEL_W,
  });
});

afterAll(() => {
  for (const prop of ["offsetParent", "offsetHeight", "offsetWidth"]) {
    Reflect.deleteProperty(HTMLElement.prototype, prop);
  }
});

describe("VideoMenu flyout is placed against the viewport, not just the row", () => {
  const VW = 1280;
  const VH = 800;
  const MARGIN = 8;
  const GAP = 12;

  const originalVw = window.innerWidth;
  const originalVh = window.innerHeight;

  afterAll(() => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: originalVw,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: originalVh,
    });
  });

  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: VW,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: VH,
    });
  });

  /** Put the parent row's wrapper at a known viewport rect, then open its flyout. */
  function rowRect(box: { top: number; left: number; right: number }): DOMRect {
    return {
      top: box.top,
      bottom: box.top + 34,
      left: box.left,
      right: box.right,
      width: box.right - box.left,
      height: 34,
      x: box.left,
      y: box.top,
      toJSON: () => ({}),
    };
  }

  function openAt(rect: { top: number; right: number }): HTMLElement {
    renderMenu({ entries: NESTED_ENTRIES });
    const row = rowByLabel(rootMenu(), /Audio/);
    hoverArea(row).getBoundingClientRect = () => rowRect({ ...rect, left: 0 });
    fireEvent.click(row);
    return flyouts()[0] as HTMLElement;
  }

  it("sits beside its row when there is room on both sides", () => {
    const flyout = openAt({ top: 300, right: 400 });

    // No vertical shift: the panel's top tracks the row's top.
    expect(flyout.style.top).toBe("0px");
    expect(flyout.style.left).toBe(`calc(100% + ${String(GAP)}px)`);
    expect(flyout.style.right).toBe("auto");
  });

  it("slides UP so a row near the BOTTOM edge stays fully on screen", () => {
    const flyout = openAt({ top: VH - 40, right: 400 });

    // The panel would end at 800 + 200; it is pulled up until its bottom clears
    // the margin: top = 800 - 200 - 8 = 592, i.e. 168px above the row.
    const shift = Number.parseFloat(flyout.style.top);
    expect(shift).toBe(-(VH - 40 - (VH - PANEL_H - MARGIN)));
    expect(VH - 40 + shift + PANEL_H).toBeLessThanOrEqual(VH - MARGIN);
  });

  it("slides DOWN so a row at the TOP edge stays fully on screen", () => {
    const flyout = openAt({ top: 0, right: 400 });

    expect(flyout.style.top).toBe(`${String(MARGIN)}px`);
    expect(0 + Number.parseFloat(flyout.style.top)).toBeGreaterThanOrEqual(0);
  });

  it("keeps a TALL panel inside a short viewport", () => {
    // The queue flyout is ~280px; opening from a row near the bottom of a
    // 1080p window still has to fit.
    const flyout = openAt({ top: 900, right: 400 });
    const shift = Number.parseFloat(flyout.style.top);
    expect(900 + shift + PANEL_H).toBeLessThanOrEqual(VH - MARGIN);
  });

  it("flips to the LEFT when the right side has no room", () => {
    const flyout = openAt({ top: 300, right: VW - 10 });

    expect(flyout.style.right).toBe(`calc(100% + ${String(GAP)}px)`);
    expect(flyout.style.left).toBe("auto");
  });

  it("stays on the right while there is still room for the whole panel", () => {
    // 500 + 12 + 240 + 8 = 760 <= 1280.
    const flyout = openAt({ top: 300, right: 500 });

    expect(flyout.style.left).toBe(`calc(100% + ${String(GAP)}px)`);
    expect(flyout.style.right).toBe("auto");
  });

  it("keeps cascading LEFT once the first flyout went left", () => {
    // The bug: level 2 measured on its own, saw room on the right (it now sits
    // at the far LEFT of the screen) and flipped back � zig-zagging and landing
    // on top of the root panel. The cascade direction is inherited instead.
    renderMenu({ entries: NESTED_ENTRIES });

    const root = rootMenu();
    const audio = rowByLabel(root, /Audio/);
    // Flush against the right edge: no room on the right, so level 1 goes left.
    hoverArea(audio).getBoundingClientRect = () =>
      rowRect({ top: 300, left: 740, right: 1274 });
    fireEvent.click(audio);

    const level1 = flyouts()[0] as HTMLElement;
    expect(level1.style.right).toBe(`calc(100% + ${String(GAP)}px)`);

    // Its child now sits around x=470, where the right side looks wide open �
    // it must not take the bait.
    const childRow = rowByLabel(level1, /Audio track/);
    hoverArea(childRow).getBoundingClientRect = () =>
      rowRect({ top: 340, left: 240, right: 474 });
    fireEvent.click(childRow);

    const level2 = flyouts()[1] as HTMLElement;
    expect(level2).toBeDefined();
    expect(level2.style.right).toBe(`calc(100% + ${String(GAP)}px)`);
    expect(level2.style.left).toBe("auto");
  });

  it("cascades RIGHT the same way when the first flyout had room", () => {
    renderMenu({ entries: NESTED_ENTRIES });

    const audio = rowByLabel(rootMenu(), /Audio/);
    hoverArea(audio).getBoundingClientRect = () =>
      rowRect({ top: 300, left: 100, right: 400 });
    fireEvent.click(audio);
    expect((flyouts()[0] as HTMLElement).style.left).toBe(
      `calc(100% + ${String(GAP)}px)`,
    );

    const childRow = rowByLabel(flyouts()[0] as HTMLElement, /Audio track/);
    hoverArea(childRow).getBoundingClientRect = () =>
      rowRect({ top: 340, left: 412, right: 646 });
    fireEvent.click(childRow);

    const level2 = flyouts()[1] as HTMLElement;
    expect(level2.style.left).toBe(`calc(100% + ${String(GAP)}px)`);
    expect(level2.style.right).toBe("auto");
  });

  it("flips to the left even when the row is also near the top", () => {
    const flyout = openAt({ top: 0, right: VW - 5 });

    expect(flyout.style.right).toBe(`calc(100% + ${String(GAP)}px)`);
    expect(flyout.style.top).toBe(`${String(MARGIN)}px`);
  });

  it("does not shift when the pointer travels from the row into its own flyout", () => {
    stubPointer(true);
    try {
      renderMenu({ entries: NESTED_ENTRIES });
      const row = rowByLabel(rootMenu(), /Audio/);
      const wrapper = hoverArea(row);
      wrapper.getBoundingClientRect = () => ({
        top: 300,
        bottom: 334,
        left: 0,
        right: 400,
        width: 400,
        height: 34,
        x: 0,
        y: 300,
        toJSON: () => ({}),
      });
      fireEvent.mouseOver(wrapper);
      const flyout = flyouts()[0] as HTMLElement;
      const before = { top: flyout.style.top, left: flyout.style.left };

      fireEvent.mouseOut(row, { relatedTarget: flyout });
      fireEvent.mouseOver(flyout);
      // Leaving the row for its own flyout is not a close, and nothing about the
      // layout changed, so the placement must be byte-identical.
      expect(flyouts()).toHaveLength(1);
      expect({ top: flyout.style.top, left: flyout.style.left }).toEqual(
        before,
      );
    } finally {
      Reflect.deleteProperty(window, "matchMedia");
    }
  });

  it("re-places a flyout when a different parent opens", () => {
    stubPointer(true);
    try {
      renderMenu({ entries: NESTED_ENTRIES });
      const root = rootMenu();
      const audio = hoverArea(rowByLabel(root, /Audio/));
      const video = hoverArea(rowByLabel(root, /^Video$/));
      video.getBoundingClientRect = () => ({
        top: VH - 40,
        bottom: VH - 6,
        left: 0,
        right: VW - 10,
        width: VW,
        height: 34,
        x: 0,
        y: VH - 40,
        toJSON: () => ({}),
      });

      fireEvent.mouseOver(audio);
      expect(flyouts()[0]?.style.top).toBe(`${String(MARGIN)}px`);

      fireEvent.mouseOver(video);
      const swapped = flyouts()[0] as HTMLElement;
      expect(swapped.getAttribute("aria-label")).toBe("Video");
      expect(Number.parseFloat(swapped.style.top)).toBeLessThan(0);
      expect(swapped.style.right).toBe(`calc(100% + ${String(GAP)}px)`);
    } finally {
      Reflect.deleteProperty(window, "matchMedia");
    }
  });
});

describe("VideoMenu queue list is bounded and scrolled to the current track", () => {
  function queueEntries(count: number, checkedAt = -1): NativeMenuEntry[] {
    return [
      ...Array.from({ length: count }, (_unused, index) => ({
        kind: "item" as const,
        id: `menu:queue:t${String(index)}`,
        label: `${String(index + 1)}. [AEQG][1080p] Dragon Ball Z`,
        detail: String(index + 1).padStart(2, "0"),
        ...(index === checkedAt ? { checked: true } : {}),
      })),
      { kind: "item", id: "PLAYER_QUEUE_TOGGLE", label: "Toggle queue" },
    ];
  }

  function openPlaylist(children: NativeMenuEntry[]): void {
    renderMenu({
      entries: [
        {
          kind: "item",
          id: "menu:playlist",
          label: "Playlist",
          children,
        },
      ],
    });
    fireEvent.click(rowByLabel(rootMenu(), /Playlist/));
  }

  it("is placed by measurement, not by a bottom-anchored class", () => {
    renderMenu({ entries: NESTED_ENTRIES });

    fireEvent.click(rowByLabel(rootMenu(), /Audio/));
    const flyout = flyouts()[0] as HTMLElement;
    // `bottom-0` anchored the flyout's bottom to the row's bottom, so a 50-row
    // queue ran off the TOP of the screen. Placement is now measured.
    expect(flyout.className).not.toContain("bottom-0");
    expect(flyout.style.top).toMatch(/^-?\d+px$/);
  });

  it("boxes the 50-row queue in a short scroll area instead of one huge flyout", () => {
    openPlaylist(queueEntries(50));

    const box = document.querySelector<HTMLElement>("[data-queue-list]");
    expect(box).not.toBeNull();
    expect(box?.className).toContain("max-h-");
    expect(box?.className).toContain("overflow-y-auto");
    // All 50 rows are still rendered � the box scrolls, nothing is dropped.
    expect(box?.querySelectorAll('[role="menuitem"]').length).toBe(50);
    // The command rows below the queue stay OUT of the scroll box.
    expect(box?.textContent ?? "").not.toContain("Toggle queue");
    expect(
      document.querySelector("[data-queue-list]")?.parentElement?.textContent ??
        "",
    ).toContain("Toggle queue");
  });

  it("centres the track being played inside the scroll box", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });
    try {
      openPlaylist(queueEntries(50, 34));

      const box = document.querySelector<HTMLElement>("[data-queue-list]");
      const current = box?.querySelector<HTMLElement>('[aria-checked="true"]');
      expect(current).not.toBeNull();
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
      expect(scrollIntoView.mock.instances[0]).toBe(current);
    } finally {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  });

  it("renders the episode badge right-aligned, never inside the truncated label", () => {
    renderMenu({
      entries: [
        {
          kind: "item",
          id: "menu:queue:a",
          label: "38. [AEQG][1080p] Dragon B�",
          detail: "038",
        },
      ],
    });

    const row = rowByLabel(rootMenu(), /Dragon B/);
    // The label itself is untouched � the badge is a sibling, so truncation of
    // the name can never eat the number.
    expect(row.querySelector("span.truncate")?.textContent).toBe(
      "38. [AEQG][1080p] Dragon B�",
    );
    const badge = row.querySelector("span.ml-auto");
    expect(badge?.textContent).toBe("038");
    expect(badge).toHaveClass("text-xs", "tabular-nums");
  });

  it("renders no badge slot for a row that has no detail", () => {
    openPlaylist(queueEntries(2));

    const toggle = rowByLabel(flyouts()[0] as HTMLElement, /Toggle queue/);
    expect(toggle.querySelector("span.ml-auto")).toBeNull();
    // ...while the queue rows do have one.
    expect(
      rowByLabel(flyouts()[0] as HTMLElement, /Dragon Ball/).querySelector(
        "span.ml-auto",
      ),
    ).not.toBeNull();
  });
});

describe("VideoMenu hover is ignored without a pointer (touch / hoverless)", () => {
  beforeEach(() => {
    stubPointer(false);
  });
  afterEach(() => {
    Reflect.deleteProperty(window, "matchMedia");
  });

  it("hover opens nothing, but the click toggle still works", () => {
    renderMenu();

    const audio = rowByLabel(rootMenu(), /Audio/);
    fireEvent.mouseOver(hoverArea(audio));
    expect(flyouts()).toHaveLength(0);

    fireEvent.click(audio);
    expect(flyouts()).toHaveLength(1);

    // Click is still a TOGGLE on a touch device (open -> closed).
    fireEvent.click(audio);
    expect(flyouts()).toHaveLength(0);
  });

  it("a child picked by touch is still dispatched exactly once", () => {
    const { props } = renderMenu();

    fireEvent.click(rowByLabel(rootMenu(), /Audio/));
    fireEvent.click(rowByLabel(flyouts()[0] as HTMLElement, /Commentary/));

    expect(props.onSelect).toHaveBeenCalledTimes(1);
    expect(props.onSelect).toHaveBeenCalledWith("menu:audio:1");
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
    // opened upwards, 8px above it � the bar's More button lives at the bottom.
    expect(menu.style.right).toBe("0px");
    expect(menu.style.bottom).toBe("108px");
  });

  it("a submenu from that right-edge button opens LEFT � there is no room right", () => {
    setViewport(1280, 800);
    renderMenu({ anchorPoint: null, buttonRect: RECT });

    // Tie the two halves together: read where the panel actually landed, then
    // feed the row the geometry it really has there. The panel is flush against
    // the right edge (right: 0), so its rows have zero clearance on the right
    // and the submenu cascades LEFT � which is the native Windows/macOS rule
    // and the wanted behaviour. The panel itself must NOT move to make room:
    // it stays anchored to the button that opened it.
    const panelRight = 1280 - Number.parseFloat(rootMenu().style.right);
    const row = rowByLabel(rootMenu(), /Audio/);
    hoverArea(row).getBoundingClientRect = () => ({
      top: 300,
      bottom: 334,
      left: panelRight - 300,
      right: panelRight - 6, // the panel's own right padding
      width: 300,
      height: 34,
      x: panelRight - 300,
      y: 300,
      toJSON: () => ({}),
    });

    fireEvent.click(row);

    const flyout = flyouts()[0] as HTMLElement;
    expect(flyout.style.right).toBe("calc(100% + 12px)");
    expect(flyout.style.left).toBe("auto");
    // The panel never shifted to make room for the submenu.
    expect(rootMenu().style.right).toBe("0px");
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

describe("VideoMenu submenu close delay", () => {
  it("delays closing the submenu on root mouse leave and cancels on submenu enter", () => {
    stubPointer(true);
    const { unmount } = renderMenu();
    const audio = rowByLabel(rootMenu(), /Audio/);
    expect(audio).toHaveAttribute("aria-expanded", "false");
    fireEvent.mouseOver(hoverArea(audio));
    expect(audio).toHaveAttribute("aria-expanded", "true");
    expect(flyouts()).toHaveLength(1);

    vi.useFakeTimers();
    fireEvent.mouseLeave(rootMenu());

    // Still open immediately after leaving.
    expect(flyouts()).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(flyouts()).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(flyouts()).toHaveLength(0);

    unmount();
    Reflect.deleteProperty(window, "matchMedia");
    vi.useRealTimers();
  });
});
