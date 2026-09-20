// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar, type SidebarProps } from "./Sidebar";
import en from "../../locales/en/translation.json";
import type { DriveStorageQuota } from "../../utils/driveApi";
import { DEBUG_EVENTS } from "../debug/debugEvents";

vi.mock("react-i18next", () => {
  // Resolve keys against the real en resources so assertions read the
  // shipped copy instead of hard-coded fallbacks.
  const resolveKey = (key: string): string | undefined => {
    let acc: unknown = en;
    for (const part of key.split(".")) {
      if (typeof acc === "object" && acc !== null) {
        acc = (acc as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }
    return typeof acc === "string" ? acc : undefined;
  };
  return {
    useTranslation: () => ({
      t: (key: string, fallback?: string) => resolveKey(key) ?? fallback ?? key,
    }),
  };
});

vi.mock("lucide-react", () => {
  const icons = [
    "Home",
    "HardDrive",
    "Settings",
    "Heart",
    "Plus",
    "ListMusic",
    "LogOut",
    "Gauge",
    // Pulled in by the playlist row MoreMenu (trigger + sidebarPlaylist items).
    "Ellipsis",
    "Trash2",
    "Pencil",
    "Pin",
    "PinOff",
  ];
  const Stub = () => null;
  return Object.fromEntries(icons.map((n) => [n, Stub]));
});

const mocks = vi.hoisted(() => ({
  getPlaylists: vi.fn(),
  createPlaylist: vi.fn(),
  deletePlaylist: vi.fn(),
  updatePlaylist: vi.fn(),
  getDriveStorageQuota: vi.fn(),
  captureError: vi.fn(),
  showErrorToast: vi.fn(),
}));

vi.mock("../../utils/playlists", () => ({
  getPlaylists: mocks.getPlaylists,
  createPlaylist: mocks.createPlaylist,
  deletePlaylist: mocks.deletePlaylist,
  updatePlaylist: mocks.updatePlaylist,
}));
vi.mock("../../utils/driveApi", () => ({
  getDriveStorageQuota: mocks.getDriveStorageQuota,
  // Imported (not called) by the MoreMenu delete hook.
  deleteFile: vi.fn(),
}));
vi.mock("../../utils/errorLog", () => ({ captureError: mocks.captureError }));
vi.mock("../../utils/simpleToast", () => ({
  showErrorToast: mocks.showErrorToast,
  showSuccessToast: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const GB = 1024 * 1024 * 1024;

function makeQuota(over: Partial<DriveStorageQuota> = {}): DriveStorageQuota {
  return {
    limit: 15 * GB,
    usage: 2.4 * GB,
    usageInDrive: 2 * GB,
    usageInDriveTrash: 0.1 * GB,
    ...over,
  };
}

function baseProps(over: Partial<SidebarProps> = {}): SidebarProps {
  return {
    activeTab: "Home",
    onTabChange: () => {},
    isSidebarOpen: true,
    onToggleSidebar: () => {},
    token: "tok-1",
    ...over,
  };
}

// Color state lives on the <p> inside the fixed-height text wrapper (the
// wrapper div only handles the expand/collapse fade+slide, not colors). The
// limited case wraps the numbers in two <span>s — usage (colored by state)
// and limit (always gray); the unlimited case keeps a single plain <p>.
function quotaTextClass(): string {
  const el = screen.getByTestId("storage-quota-text").querySelector("p");
  if (!el) throw new Error("storage-quota-text <p> not found");
  const usage = el.querySelector('[data-testid="storage-quota-usage"]');
  return (usage ?? el).className;
}

function quotaLimitTextClass(): string {
  const el = screen.getByTestId("storage-quota-text").querySelector("p");
  const limit = el?.querySelector('[data-testid="storage-quota-limit"]');
  if (!limit) throw new Error("storage-quota-limit <span> not found");
  return limit.className;
}

function quotaTextContent(): string | null {
  return (
    screen.getByTestId("storage-quota-text").querySelector("p")?.textContent ??
    null
  );
}

// "X GB / Y GB" now spans two <span>s, so the string is matched against the
// <p>'s textContent (getNodeText only sees direct text-node children).
async function findQuotaText(expected: string) {
  const textEl = await screen.findByTestId("storage-quota-text");
  const p = textEl.querySelector("p");
  if (!p) throw new Error("storage-quota-text <p> not found");
  expect(p.textContent).toBe(expected);
}

describe("Sidebar storage quota", () => {
  beforeEach(() => {
    mocks.getPlaylists.mockResolvedValue([]);
    mocks.getDriveStorageQuota.mockReset();
    mocks.captureError.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("does not fetch quota and hides the section when token is null (not logged in)", () => {
    render(<Sidebar {...baseProps({ token: null })} />);
    expect(mocks.getDriveStorageQuota).not.toHaveBeenCalled();
    expect(screen.queryByTestId("storage-quota")).toBeNull();
  });

  it('fetches quota on mount and renders a bar + "X GB / Y GB" text', async () => {
    mocks.getDriveStorageQuota.mockResolvedValue(makeQuota());
    render(<Sidebar {...baseProps()} />);

    await findQuotaText("2 GB / 15 GB");
    expect(screen.getByTestId("storage-quota-bar")).toBeTruthy();
    expect(screen.getByTestId("storage-quota-bar").style.width).toBe("13%");
    // Expanded bar width == full NavItem hover-row width (sidebar 256px − nav
    // px-4 right edge 16px − storage px-4 left 16px − track ml-3 12px =
    // 212px), so the bar's right edge matches the Home/My Drive row's hover
    // extent and animates width smoothly.
    expect(screen.getByTestId("storage-quota-track").className).toContain(
      "w-[212px]",
    );
    expect(screen.getByTestId("storage-quota-track").className).toContain(
      "transition-all",
    );
    expect(screen.getByTestId("storage-quota-track").className).toContain(
      "ease-in-out",
    );
    // Track background matches the PlayerBar seekbar track color exactly
    // (light: gray-300 / dark: #2A2A2A), not the old generic gray-700.
    expect(screen.getByTestId("storage-quota-track").className).toContain(
      "bg-gray-300",
    );
    expect(screen.getByTestId("storage-quota-track").className).toContain(
      "dark:bg-[#2A2A2A]",
    );
    expect(screen.getByTestId("storage-quota-track").className).not.toContain(
      "dark:bg-gray-700",
    );
    // Flex layout so the blue + red segment divs sit side by side (no gap).
    expect(screen.getByTestId("storage-quota-track").className).toContain(
      "flex",
    );
    expect(screen.queryByTestId("storage-quota-bar-red")).toBeNull();
    // Number drops in from above the bar (slide + fade) when expanded — pure
    // CSS transition (same mechanism as exit, so both directions match).
    const textEl = screen.getByTestId("storage-quota-text");
    expect(textEl.className).toContain("opacity-100");
    expect(textEl.className).toContain("translate-y-0");
    // No tw-animate keyframes on enter — symmetric with the exit transition.
    expect(textEl.className).not.toContain("animate-in");
    expect(textEl.className).not.toContain("slide-in-from-top-2");
    // Text runs SIMULTANEOUSLY with the track (no delay waiting for the
    // track's width transition to finish first).
    expect(textEl.className).not.toContain("delay-300");
    expect(textEl.className).not.toContain("fill-mode-backwards");
    // 300ms — synced with the track's duration-300 and the sidebar width
    // animation (was 150ms: text finished fading while the track kept growing
    // for another 150ms → the reported short jank on expand; before that it
    // was 200ms + 300ms delay — user reported it as too slow).
    expect(textEl.className).toContain("duration-300");
    // overflow-hidden in BOTH states: on expand the wrapper is still narrow
    // while the track grows, and without clipping the text would wrap and
    // spill out of the fixed h-4 (the reported jank).
    expect(textEl.className).toContain("overflow-hidden");
    // transition-all (present in both states) is what makes the enter/exit
    // fade+slide run: on collapse the element transitions from its current
    // state (opacity 1, y 0) to opacity-0 -translate-y-2; expand is the
    // exact reverse over the same 150ms ease-in-out.
    expect(textEl.className).toContain("transition-all");
    expect(textEl.className).toContain("ease-in-out");
    // Text starts at the same left edge as the track (both share ml-3).
    expect(textEl.className).toContain("ml-3");
    expect(screen.getByTestId("storage-quota-track").className).toContain(
      "ml-3",
    );
    // Fixed reserved line height keeps the track vertically stable.
    expect(textEl.className).toContain("h-4");
    expect(mocks.getDriveStorageQuota).toHaveBeenCalledTimes(1);
    expect(mocks.getDriveStorageQuota).toHaveBeenCalledWith("tok-1");
  });

  it('shows only "used X GB" (no bar, no limit) when limit is absent (unlimited)', async () => {
    mocks.getDriveStorageQuota.mockResolvedValue(makeQuota({ limit: null }));
    render(<Sidebar {...baseProps()} />);

    await screen.findByText(/2 GB/);
    expect(screen.queryByTestId("storage-quota-bar")).toBeNull();
    expect(screen.queryByText(/\/ 15 GB/)).toBeNull();
    // Unlimited has no threshold concept — text keeps its neutral gray.
    expect(quotaTextClass()).toContain("text-gray-500");
    expect(quotaTextClass()).not.toContain("text-red-500");
  });

  it("renders nothing when the sidebar is collapsed and limit is absent (bar needs a limit)", async () => {
    mocks.getDriveStorageQuota.mockResolvedValue(makeQuota({ limit: null }));
    render(<Sidebar {...baseProps({ isSidebarOpen: false })} />);

    await waitFor(() => {
      expect(mocks.getDriveStorageQuota).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId("storage-quota")).toBeNull();
    expect(screen.queryByTestId("storage-quota-bar")).toBeNull();
  });

  it("hides the section without crashing when the quota fetch resolves null", async () => {
    mocks.getDriveStorageQuota.mockResolvedValue(null);
    render(<Sidebar {...baseProps()} />);

    await waitFor(() => {
      expect(mocks.getDriveStorageQuota).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId("storage-quota")).toBeNull();
  });

  it("hides the section without crashing when the quota fetch rejects", async () => {
    mocks.getDriveStorageQuota.mockRejectedValue(new Error("network down"));
    render(<Sidebar {...baseProps()} />);

    await waitFor(() => {
      expect(mocks.getDriveStorageQuota).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId("storage-quota")).toBeNull();
  });

  it("clamps the two segments to 100% total when usage exceeds the limit (no layout break)", async () => {
    mocks.getDriveStorageQuota.mockResolvedValue(
      makeQuota({ limit: 100 * GB, usageInDrive: 150 * GB }),
    );
    render(<Sidebar {...baseProps()} />);

    await findQuotaText("150 GB / 100 GB");
    const blue = screen.getByTestId("storage-quota-bar");
    const red = screen.getByTestId("storage-quota-bar-red");
    // Safe zone (0→80%) stays at the threshold even when usage is past the
    // limit; the red excess is clamped so both segments sum to exactly 100%.
    expect(blue.style.width).toBe("80%");
    expect(blue.className).toContain("bg-brand-primary");
    expect(blue.className).toContain("rounded-l-full");
    expect(red.style.width).toBe("20%");
    expect(red.className).toContain("bg-red-500");
    expect(red.className).toContain("rounded-r-full");
    expect(quotaTextClass()).toContain("text-red-500");
    // Limit half stays gray even when usage is over the limit.
    expect(quotaLimitTextClass()).toContain("text-gray-500");
    expect(quotaLimitTextClass()).toContain("dark:text-gray-400");
    expect(quotaLimitTextClass()).not.toContain("text-red-500");
    expect(quotaLimitTextClass()).not.toContain("text-brand-text");
  });

  it("fills a single blue bar (usage width) with blue text when usage is at or under the 80% threshold", async () => {
    mocks.getDriveStorageQuota.mockResolvedValue(
      makeQuota({ limit: 100 * GB, usageInDrive: 60 * GB }),
    );
    render(<Sidebar {...baseProps()} />);

    await findQuotaText("60 GB / 100 GB");
    const blue = screen.getByTestId("storage-quota-bar");
    // Fill = usage only (60%), not an 80%-capped blue segment.
    expect(blue.style.width).toBe("60%");
    expect(blue.className).toContain("bg-brand-primary");
    expect(blue.className).not.toContain("bg-red-500");
    // Full rounding kept — no segment join anymore.
    expect(blue.className).toContain("rounded-full");
    expect(blue.className).not.toContain("rounded-l-full");
    expect(screen.queryByTestId("storage-quota-bar-red")).toBeNull();
    expect(quotaTextClass()).toContain("text-brand-text");
    expect(quotaTextClass()).not.toContain("text-red-500");
    // Limit half is always neutral gray, regardless of usage state.
    expect(quotaLimitTextClass()).toContain("text-gray-500");
    expect(quotaLimitTextClass()).toContain("dark:text-gray-400");
    expect(quotaLimitTextClass()).not.toContain("text-brand-text");
    expect(quotaLimitTextClass()).not.toContain("text-red-500");
  });

  it("splits the fill into a blue safe zone (80%) + red excess (10%) with red text when usage crosses the 80% threshold", async () => {
    mocks.getDriveStorageQuota.mockResolvedValue(
      makeQuota({ limit: 100 * GB, usageInDrive: 90 * GB }),
    );
    render(<Sidebar {...baseProps()} />);

    await findQuotaText("90 GB / 100 GB");
    const blue = screen.getByTestId("storage-quota-bar");
    const red = screen.getByTestId("storage-quota-bar-red");
    // Safe zone (0→80%) stays blue; only the excess above the threshold (10%)
    // turns red — blue rounded-l + red rounded-r, joined with no gap.
    expect(blue.style.width).toBe("80%");
    expect(blue.className).toContain("bg-brand-primary");
    expect(blue.className).not.toContain("bg-red-500");
    expect(blue.className).toContain("rounded-l-full");
    expect(red.style.width).toBe("10%");
    expect(red.className).toContain("bg-red-500");
    expect(red.className).toContain("rounded-r-full");
    expect(quotaTextClass()).toContain("text-red-500");
    expect(quotaTextClass()).not.toContain("text-brand-text");
    // Limit half is always neutral gray, regardless of usage state.
    expect(quotaLimitTextClass()).toContain("text-gray-500");
    expect(quotaLimitTextClass()).toContain("dark:text-gray-400");
    expect(quotaLimitTextClass()).not.toContain("text-brand-text");
    expect(quotaLimitTextClass()).not.toContain("text-red-500");
  });

  it("treats exactly 80% usage as safe (blue fill, blue text)", async () => {
    mocks.getDriveStorageQuota.mockResolvedValue(
      makeQuota({ limit: 100 * GB, usageInDrive: 80 * GB }),
    );
    render(<Sidebar {...baseProps()} />);

    await findQuotaText("80 GB / 100 GB");
    const bar = screen.getByTestId("storage-quota-bar");
    expect(bar.style.width).toBe("80%");
    expect(bar.className).toContain("bg-brand-primary");
    expect(bar.className).toContain("rounded-full");
    expect(screen.queryByTestId("storage-quota-bar-red")).toBeNull();
    expect(quotaTextClass()).toContain("text-brand-text");
    expect(quotaTextClass()).not.toContain("text-red-500");
    // Limit half is always neutral gray, regardless of usage state.
    expect(quotaLimitTextClass()).toContain("text-gray-500");
    expect(quotaLimitTextClass()).toContain("dark:text-gray-400");
    expect(quotaLimitTextClass()).not.toContain("text-brand-text");
    expect(quotaLimitTextClass()).not.toContain("text-red-500");
  });

  it("shows the blue safe-zone + red excess segments in the collapsed track too when over threshold", async () => {
    mocks.getDriveStorageQuota.mockResolvedValue(
      makeQuota({ limit: 100 * GB, usageInDrive: 90 * GB }),
    );
    render(<Sidebar {...baseProps({ isSidebarOpen: false })} />);

    const blue = await screen.findByTestId("storage-quota-bar");
    const red = screen.getByTestId("storage-quota-bar-red");
    expect(blue.style.width).toBe("80%");
    expect(blue.className).toContain("bg-brand-primary");
    expect(blue.className).toContain("rounded-l-full");
    expect(red.style.width).toBe("10%");
    expect(red.className).toContain("bg-red-500");
    expect(red.className).toContain("rounded-r-full");
    // Red segment exists inside the narrow collapsed track (w-11).
    expect(screen.getByTestId("storage-quota-track").className).toContain(
      "w-11",
    );
    expect(quotaTextClass()).toContain("text-red-500");
  });

  it("shows only a compact bar (no number) when the sidebar is collapsed", async () => {
    mocks.getDriveStorageQuota.mockResolvedValue(makeQuota());
    render(<Sidebar {...baseProps({ isSidebarOpen: false })} />);

    expect(await screen.findByTestId("storage-quota-bar")).toBeTruthy();
    // The text wrapper stays mounted (reserves fixed space so the track never
    // jumps) but is invisible. Exit is a CSS TRANSITION (not the old
    // animate-out keyframes): on collapse the element transitions from its
    // current state (opacity 1, y 0) to opacity-0 -translate-y-2 — sliding
    // UP 8px while fading, so it "lifts back" visibly instead of snapping
    // invisible instantly (the old animate-out started from an already
    // opacity-0 element, so its keyframes were invisible).
    const textEl = screen.getByTestId("storage-quota-text");
    expect(textEl.className).toContain("opacity-0");
    expect(textEl.className).toContain("-translate-y-2");
    expect(textEl.className).toContain("transition-all");
    expect(textEl.className).toContain("duration-300");
    expect(textEl.className).toContain("ease-in-out");
    expect(textEl.className).not.toContain("animate-out");
    expect(textEl.className).not.toContain("fade-out");
    expect(textEl.className).not.toContain("slide-out-to-bottom-6");
    expect(textEl.className).not.toContain("delay-300");
    expect(textEl.className).not.toContain("animate-in");
    // overflow-hidden stays on while collapsed (prevents spill during the
    // narrow phase of the expand animation).
    expect(textEl.className).toContain("overflow-hidden");
    expect(quotaTextContent()).toBe("2 GB / 15 GB");
    // Collapsed: same container padding and same track ml-3 as expanded, so
    // the track's left edge does not jump (bar just shrinks w-[212px] → w-11).
    expect(screen.getByTestId("storage-quota").className).toContain("px-4");
    expect(screen.getByTestId("storage-quota").className).not.toContain("px-2");
    expect(screen.getByTestId("storage-quota").className).not.toContain(
      "justify-center",
    );
    expect(screen.getByTestId("storage-quota-track").className).toContain(
      "w-11",
    );
    expect(screen.getByTestId("storage-quota-track").className).toContain(
      "ml-3",
    );
    // Tooltip kept for hover access to the numbers.
    expect(screen.getByTestId("storage-quota").getAttribute("title")).toContain(
      "2 GB / 15 GB",
    );
  });

  it("keeps the track at the same left edge in both states (no horizontal jump)", async () => {
    mocks.getDriveStorageQuota.mockResolvedValue(makeQuota());
    const { rerender } = render(<Sidebar {...baseProps()} />);
    await findQuotaText("2 GB / 15 GB");

    // Expanded: container px-4 (16px) + track ml-3 (12px) → left edge 28px.
    expect(screen.getByTestId("storage-quota").className).toContain("px-4");
    expect(screen.getByTestId("storage-quota").className).not.toContain("px-2");
    expect(screen.getByTestId("storage-quota-track").className).toContain(
      "ml-3",
    );

    rerender(<Sidebar {...baseProps({ isSidebarOpen: false })} />);
    // Collapsed: identical px-4 container padding + ml-3 on the narrower
    // track (w-11), so the left edge stays at 28px — no jump, no centering
    // offset, the bar only shrinks in width.
    expect(screen.getByTestId("storage-quota").className).toContain("px-4");
    expect(screen.getByTestId("storage-quota").className).not.toContain("px-2");
    expect(screen.getByTestId("storage-quota").className).not.toContain(
      "justify-center",
    );
    expect(screen.getByTestId("storage-quota-track").className).toContain(
      "ml-3",
    );
    expect(screen.getByTestId("storage-quota-track").className).toContain(
      "w-11",
    );
  });

  it("reserves identical text space in both states so the track cannot jump", async () => {
    mocks.getDriveStorageQuota.mockResolvedValue(makeQuota());
    const { rerender } = render(<Sidebar {...baseProps()} />);
    await findQuotaText("2 GB / 15 GB");
    const expandedText = screen.getByTestId("storage-quota-text");

    rerender(<Sidebar {...baseProps({ isSidebarOpen: false })} />);
    const collapsedText = screen.getByTestId("storage-quota-text");
    expect(collapsedText.className).toContain("mt-1.5");
    expect(collapsedText.className).toContain("h-4");
    expect(expandedText.className).toContain("mt-1.5");
    expect(expandedText.className).toContain("h-4");
    expect(collapsedText.className).not.toContain("animate-in");
  });

  it("re-fetches quota on the user-changed event", async () => {
    mocks.getDriveStorageQuota.mockResolvedValue(makeQuota());
    render(<Sidebar {...baseProps()} />);

    await findQuotaText("2 GB / 15 GB");
    expect(mocks.getDriveStorageQuota).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new CustomEvent("user-changed"));
    });
    await waitFor(() => {
      expect(mocks.getDriveStorageQuota).toHaveBeenCalledTimes(2);
    });
  });

  // Debug QUOTA presets (Ctrl+Shift+D panel → "Storage quota" section) push
  // quota state directly through the DEV-only event bus. The fetch mock stays
  // PENDING (never-settling promise) so the real fetch cannot race and
  // overwrite the debug-set quota; the card then shows exactly the debug data.
  const dispatchQuota = (detail: {
    usageInDrive: number;
    limit: number | null;
  }) => {
    act(() => {
      window.dispatchEvent(new CustomEvent(DEBUG_EVENTS.QUOTA, { detail }));
    });
  };

  it("debug QUOTA under 80% renders the card with a blue-only bar (no red segment)", () => {
    mocks.getDriveStorageQuota.mockReturnValue(new Promise(() => {}));
    render(<Sidebar {...baseProps()} />);

    dispatchQuota({ usageInDrive: 40 * GB, limit: 100 * GB });

    expect(screen.getByTestId("storage-quota")).toBeTruthy();
    const blue = screen.getByTestId("storage-quota-bar");
    expect(blue.style.width).toBe("40%");
    expect(blue.className).toContain("bg-brand-primary");
    expect(screen.queryByTestId("storage-quota-bar-red")).toBeNull();
    expect(quotaTextClass()).toContain("text-brand-text");
  });

  it("debug QUOTA over 80% renders the red excess segment with red usage text", () => {
    mocks.getDriveStorageQuota.mockReturnValue(new Promise(() => {}));
    render(<Sidebar {...baseProps()} />);

    dispatchQuota({ usageInDrive: 95 * GB, limit: 100 * GB });

    const blue = screen.getByTestId("storage-quota-bar");
    const red = screen.getByTestId("storage-quota-bar-red");
    // Safe zone (0→80%) stays blue; the 15% above the threshold turns red.
    expect(blue.style.width).toBe("80%");
    expect(red.style.width).toBe("15%");
    expect(red.className).toContain("bg-red-500");
    expect(quotaTextClass()).toContain("text-red-500");
  });

  it("debug QUOTA unlimited renders the unlimited text with no bar", () => {
    mocks.getDriveStorageQuota.mockReturnValue(new Promise(() => {}));
    render(<Sidebar {...baseProps()} />);

    dispatchQuota({ usageInDrive: 50 * GB, limit: null });

    expect(screen.getByTestId("storage-quota")).toBeTruthy();
    expect(screen.queryByTestId("storage-quota-bar")).toBeNull();
    expect(screen.queryByTestId("storage-quota-bar-red")).toBeNull();
    expect(quotaTextContent()).toBe("Storage used 50 GB");
  });

  it("debug QUOTA does not render the card when there is no token", () => {
    mocks.getDriveStorageQuota.mockReturnValue(new Promise(() => {}));
    render(<Sidebar {...baseProps({ token: null })} />);

    dispatchQuota({ usageInDrive: 40 * GB, limit: 100 * GB });

    expect(screen.queryByTestId("storage-quota")).toBeNull();
    expect(mocks.getDriveStorageQuota).not.toHaveBeenCalled();
  });

  it("debug QUOTA after unmount is a no-op (listener cleaned up, no crash)", () => {
    mocks.getDriveStorageQuota.mockReturnValue(new Promise(() => {}));
    const { unmount } = render(<Sidebar {...baseProps()} />);

    dispatchQuota({ usageInDrive: 40 * GB, limit: 100 * GB });
    expect(screen.getByTestId("storage-quota")).toBeTruthy();

    unmount();
    expect(() => {
      dispatchQuota({ usageInDrive: 95 * GB, limit: 100 * GB });
    }).not.toThrow();
  });

  it("hides the section when the token prop changes to null (logout)", async () => {
    mocks.getDriveStorageQuota.mockResolvedValue(makeQuota());
    const { rerender } = render(<Sidebar {...baseProps()} />);

    await findQuotaText("2 GB / 15 GB");
    rerender(<Sidebar {...baseProps({ token: null })} />);

    await waitFor(() => {
      expect(screen.queryByTestId("storage-quota")).toBeNull();
    });
  });

  it("still renders playlists normally when logged in with quota", async () => {
    mocks.getPlaylists.mockResolvedValue([
      { id: "pl-1", name: "My List", userEmail: "u", createdAt: 0, tracks: [] },
    ]);
    mocks.getDriveStorageQuota.mockResolvedValue(makeQuota());
    render(<Sidebar {...baseProps({ activeTab: "playlist_pl-1" })} />);

    expect(await screen.findByText("My List")).toBeTruthy();
    await findQuotaText("2 GB / 15 GB");
  });

  it("fires the create-playlist flow unchanged (no regression on existing behavior)", async () => {
    mocks.createPlaylist.mockResolvedValue({
      id: "pl-new",
      name: "New",
      userEmail: "u",
      createdAt: 0,
      tracks: [],
    });
    mocks.getDriveStorageQuota.mockResolvedValue(makeQuota());
    const onTabChange = vi.fn();
    render(<Sidebar {...baseProps({ onTabChange })} />);

    const user = userEvent.setup();
    await user.click(screen.getByTitle("Create Playlist"));
    const input = screen.getByPlaceholderText("My Playlist #1");
    await user.type(input, "New{Enter}");

    await waitFor(() => {
      expect(onTabChange).toHaveBeenCalledWith("playlist_pl-new");
    });
  });
});

describe("Sidebar avatar fallback", () => {
  beforeEach(() => {
    mocks.getPlaylists.mockResolvedValue([]);
    mocks.getDriveStorageQuota.mockResolvedValue(makeQuota());
    mocks.captureError.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows the img when the profile picture loads", () => {
    render(
      <Sidebar
        {...baseProps({
          userProfile: {
            name: "Alice",
            email: "a@b.c",
            picture: "https://example.com/pic.jpg",
          },
        })}
      />,
    );
    expect(screen.getByAltText("Profile")).toBeTruthy();
    expect(screen.queryByText("A")).toBeNull();
  });

  it("replaces the img with the initial-letter fallback when the picture fails to load (onError)", () => {
    render(
      <Sidebar
        {...baseProps({
          userProfile: {
            name: "Alice",
            email: "a@b.c",
            picture: "https://example.com/pic.jpg",
          },
        })}
      />,
    );
    const img = screen.getByAltText("Profile");
    fireEvent.error(img);
    expect(screen.queryByAltText("Profile")).toBeNull();
    const letter = screen.getByText("A");
    expect(letter.className).toContain("text-brand-text");
    const letterParent = letter.parentElement;
    expect(letterParent).not.toBeNull();
    if (letterParent) {
      expect(letterParent.className).toContain("flex");
    }
  });

  it("keeps the question-mark guest avatar when not logged in", () => {
    render(<Sidebar {...baseProps({ token: null, userProfile: null })} />);
    expect(screen.getByText("?")).toBeTruthy();
    expect(screen.queryByAltText("Profile")).toBeNull();
  });
});

describe("Sidebar playlist row + button alignment", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  // The label wrapper stays flex-1 with NO fixed max-width cap in both
  // states: it absorbs all free space, so the + is pinned to the row right
  // edge when expanded and glides with the label during the transition.
  // A justify-between switch (or a 160px cap) re-anchors instantly and
  // makes the + jump mid-animation.
  it("pushes the playlist + button to the row right edge via the flex-1 label when expanded", () => {
    render(<Sidebar {...baseProps({ token: "tok-1" })} />);
    const btn = screen.getByTitle("Create Playlist");
    // The button's parent is the playlist row container.
    const row = btn.parentElement;
    expect(row).not.toBeNull();
    if (row) {
      expect(row.className).not.toContain("justify-between");
      const label = row.firstElementChild;
      expect(label).not.toBeNull();
      if (label) {
        expect(label.className).toContain("flex-1");
        expect(label.className).toContain("max-w-full");
      }
    }
    // Expanded: no ml-3 spacer (the flex-1 label takes the free space).
    expect(btn.className).not.toContain("ml-3");
  });

  it("keeps the legacy collapsed layout (label collapses to max-w-0, button keeps ml-3)", () => {
    render(
      <Sidebar {...baseProps({ isSidebarOpen: false, token: "tok-1" })} />,
    );
    const btn = screen.getByTitle("Create Playlist");
    const row = btn.parentElement;
    expect(row).not.toBeNull();
    if (row) {
      expect(row.className).not.toContain("justify-between");
      const label = row.firstElementChild;
      expect(label).not.toBeNull();
      if (label) {
        expect(label.className).toContain("flex-1");
        expect(label.className).toContain("max-w-0");
      }
    }
    expect(btn.className).toContain("ml-3");
  });
});

describe("Sidebar playlist more menu", () => {
  const ALPHA = {
    id: "pl-1",
    name: "Alpha",
    userEmail: "u",
    createdAt: 1,
    tracks: [],
  };
  const BETA = {
    id: "pl-2",
    name: "Beta",
    userEmail: "u",
    createdAt: 2,
    tracks: [],
  };

  beforeEach(() => {
    mocks.getPlaylists.mockResolvedValue([ALPHA, BETA]);
    mocks.deletePlaylist.mockReset();
    mocks.updatePlaylist.mockReset();
    mocks.getDriveStorageQuota.mockResolvedValue(makeQuota());
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  function playlistMenu(): HTMLElement {
    const menu = document.body.querySelector<HTMLElement>('[role="menu"]');
    if (!menu) throw new Error("playlist menu not found");
    return menu;
  }

  function menuItemNames(menu: HTMLElement): string[] {
    return within(menu)
      .getAllByRole("menuitem")
      .map((b) => b.textContent?.trim() ?? "");
  }

  function openMenuByRightClick(name: string): HTMLElement {
    fireEvent.contextMenu(screen.getByText(name));
    return playlistMenu();
  }

  it("renders one More actions trigger per playlist only while the sidebar is expanded", async () => {
    const { rerender } = render(<Sidebar {...baseProps()} />);
    await screen.findByText("Alpha");
    expect(
      screen.getAllByRole("button", { name: "More actions" }),
    ).toHaveLength(2);

    rerender(<Sidebar {...baseProps({ isSidebarOpen: false })} />);
    // Collapsed: no trigger, no invisible hit area left behind.
    expect(
      screen.queryAllByRole("button", { name: "More actions" }),
    ).toHaveLength(0);
  });

  it("keeps playlist rows selectable when collapsed and opens no menu on right-click", async () => {
    const onTabChange = vi.fn();
    render(<Sidebar {...baseProps({ isSidebarOpen: false, onTabChange })} />);
    await screen.findByText("Alpha");

    fireEvent.click(screen.getByText("Alpha"));
    expect(onTabChange).toHaveBeenCalledWith("playlist_pl-1");

    fireEvent.contextMenu(screen.getByText("Beta"));
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
  });

  it("opens the playlist menu on right-click (Delete/Rename/Pin), never the track menu", async () => {
    render(<Sidebar {...baseProps()} />);
    await screen.findByText("Alpha");

    const menu = openMenuByRightClick("Beta");
    expect(menuItemNames(menu)).toEqual(["Delete", "Rename", "Pin to top"]);
    for (const absent of [
      "Remove from Playlist",
      "Locate File",
      "Select multiple items",
      "Add to queue",
      "Move to...",
      "Download Song",
    ]) {
      expect(within(menu).queryByRole("menuitem", { name: absent })).toBeNull();
    }
  });

  it("keeps a single menu open when right-clicking two different playlists", async () => {
    render(<Sidebar {...baseProps()} />);
    await screen.findByText("Alpha");

    openMenuByRightClick("Alpha");
    fireEvent.contextMenu(screen.getByText("Beta"));

    expect(document.body.querySelectorAll('[role="menu"]')).toHaveLength(1);
  });

  it("opens the menu from the More actions trigger without selecting the playlist", async () => {
    const onTabChange = vi.fn();
    render(<Sidebar {...baseProps({ onTabChange })} />);
    await screen.findByText("Alpha");

    const firstTrigger = screen.getAllByRole("button", {
      name: "More actions",
    })[0];
    if (!firstTrigger) throw new Error("trigger missing");
    fireEvent.click(firstTrigger);

    expect(onTabChange).not.toHaveBeenCalled();
    expect(menuItemNames(playlistMenu())).toEqual([
      "Delete",
      "Rename",
      "Pin to top",
    ]);
  });

  it("Pin to top persists pinned=true and the pinned playlist sorts first (stable groups)", async () => {
    render(<Sidebar {...baseProps()} />);
    await screen.findByText("Alpha");

    fireEvent.click(
      within(openMenuByRightClick("Beta")).getByRole("menuitem", {
        name: "Pin to top",
      }),
    );

    await waitFor(() => {
      expect(mocks.updatePlaylist).toHaveBeenCalledWith("pl-2", {
        pinned: true,
      });
    });
    expect(document.body.querySelector('[role="menu"]')).toBeNull();

    // The store write dispatches playlists-updated; the sidebar re-reads the
    // data layer, so simulate the persisted pinned row.
    mocks.getPlaylists.mockResolvedValue([{ ...BETA, pinned: true }, ALPHA]);
    act(() => {
      window.dispatchEvent(new CustomEvent("playlists-updated"));
    });

    await waitFor(() => {
      expect(
        screen.getAllByText(/^(Alpha|Beta)$/).map((el) => el.textContent),
      ).toEqual(["Beta", "Alpha"]);
    });
  });

  it("chỉ playlist pinned mới có pin marker đứng ngay trước tên", async () => {
    mocks.getPlaylists.mockResolvedValue([{ ...BETA, pinned: true }, ALPHA]);
    render(<Sidebar {...baseProps()} />);
    await screen.findByText("Beta");

    const pin = screen.getByTestId("playlist-pin-pl-2");
    // Marker nằm trong cùng block tên, ngay trước text của playlist.
    expect(pin.nextElementSibling?.textContent).toBe("Beta");
    expect(screen.queryByTestId("playlist-pin-pl-1")).toBeNull();
  });

  it("Rename opens the inline input prefilled; Enter saves the trimmed name", async () => {
    render(<Sidebar {...baseProps()} />);
    await screen.findByText("Alpha");

    fireEvent.click(
      within(openMenuByRightClick("Alpha")).getByRole("menuitem", {
        name: "Rename",
      }),
    );

    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    const input = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Rename",
    });
    expect(input.value).toBe("Alpha");

    const user = userEvent.setup();
    await user.clear(input);
    await user.type(input, "  Alpha Renamed  {Enter}");

    await waitFor(() => {
      expect(mocks.updatePlaylist).toHaveBeenCalledWith("pl-1", {
        name: "Alpha Renamed",
      });
    });
    expect(mocks.createPlaylist).not.toHaveBeenCalled();
  });

  it("Rename cancel: unchanged name writes nothing and closes the input", async () => {
    render(<Sidebar {...baseProps()} />);
    await screen.findByText("Alpha");

    fireEvent.click(
      within(openMenuByRightClick("Alpha")).getByRole("menuitem", {
        name: "Rename",
      }),
    );
    const input = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Rename",
    });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(screen.queryByRole("textbox", { name: "Rename" })).toBeNull();
    });
    expect(mocks.updatePlaylist).not.toHaveBeenCalled();
  });

  it("Delete opens the in-app confirm modal; confirming removes the playlist and redirects the open tab", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    const onTabChange = vi.fn();
    render(
      <Sidebar {...baseProps({ activeTab: "playlist_pl-1", onTabChange })} />,
    );
    await screen.findByText("Alpha");

    fireEvent.click(
      within(openMenuByRightClick("Alpha")).getByRole("menuitem", {
        name: "Delete",
      }),
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain(
      "This removes the playlist only. Your music files are not deleted.",
    );
    // Least destructive control owns the initial focus (APG dialog-modal).
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Cancel" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(mocks.deletePlaylist).toHaveBeenCalledWith("pl-1");
    });
    await waitFor(() => {
      expect(onTabChange).toHaveBeenCalledWith("Home");
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    // The delete confirmation is in-app now — no native script dialog.
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("Cancel in the confirm modal closes it without deleting", async () => {
    render(<Sidebar {...baseProps()} />);
    await screen.findByText("Alpha");

    fireEvent.click(
      within(openMenuByRightClick("Alpha")).getByRole("menuitem", {
        name: "Delete",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.deletePlaylist).not.toHaveBeenCalled();
    expect(screen.getByText("Alpha")).toBeTruthy();
  });

  it("Escape closes the confirm modal without deleting", async () => {
    render(<Sidebar {...baseProps()} />);
    await screen.findByText("Alpha");

    fireEvent.click(
      within(openMenuByRightClick("Alpha")).getByRole("menuitem", {
        name: "Delete",
      }),
    );
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.deletePlaylist).not.toHaveBeenCalled();
  });

  it("backdrop click (but not dialog click) closes the confirm modal without deleting", async () => {
    render(<Sidebar {...baseProps()} />);
    await screen.findByText("Alpha");

    fireEvent.click(
      within(openMenuByRightClick("Alpha")).getByRole("menuitem", {
        name: "Delete",
      }),
    );

    const dialog = screen.getByRole("dialog");
    fireEvent.click(dialog);
    expect(screen.getByRole("dialog")).toBeTruthy();

    const backdrop = dialog.parentElement;
    if (!backdrop) throw new Error("confirm backdrop missing");
    fireEvent.click(backdrop);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.deletePlaylist).not.toHaveBeenCalled();
  });

  it("deleting a playlist that is not the open tab does not redirect", async () => {
    const onTabChange = vi.fn();
    render(
      <Sidebar {...baseProps({ activeTab: "playlist_pl-1", onTabChange })} />,
    );
    await screen.findByText("Alpha");

    fireEvent.click(
      within(openMenuByRightClick("Beta")).getByRole("menuitem", {
        name: "Delete",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(mocks.deletePlaylist).toHaveBeenCalledWith("pl-2");
    });
    expect(onTabChange).not.toHaveBeenCalled();
  });
});
