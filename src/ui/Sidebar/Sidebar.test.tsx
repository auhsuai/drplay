// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar, type SidebarProps } from "./Sidebar";
import en from "../../locales/en/translation.json";
import type { DriveStorageQuota } from "../../utils/driveApi";

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
    "CloudUpload",
  ];
  const Stub = () => null;
  return Object.fromEntries(icons.map((n) => [n, Stub]));
});

const mocks = vi.hoisted(() => ({
  getPlaylists: vi.fn(),
  createPlaylist: vi.fn(),
  getDriveStorageQuota: vi.fn(),
  captureError: vi.fn(),
  showErrorToast: vi.fn(),
}));

vi.mock("../../utils/playlists", () => ({
  getPlaylists: mocks.getPlaylists,
  createPlaylist: mocks.createPlaylist,
}));
vi.mock("../../utils/driveApi", () => ({
  getDriveStorageQuota: mocks.getDriveStorageQuota,
}));
vi.mock("../../utils/errorLog", () => ({ captureError: mocks.captureError }));
vi.mock("../../utils/simpleToast", () => ({
  showErrorToast: mocks.showErrorToast,
}));
// UploadButton (rendered in the header when token is set) pulls in the real
// uploadManager (dexie/db chain) and the Tauri dialog plugin — neither is
// exercised by these tests, so stand-ins keep the jsdom environment isolated.
vi.mock("../../utils/uploadManager", () => ({ startUploads: vi.fn() }));
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
    // (light: gray-200 / dark: #2A2A2A), not the old generic gray-700.
    expect(screen.getByTestId("storage-quota-track").className).toContain(
      "bg-gray-200",
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
    expect(blue.className).toContain("bg-[#4285F4]");
    expect(blue.className).toContain("rounded-l-full");
    expect(red.style.width).toBe("20%");
    expect(red.className).toContain("bg-red-500");
    expect(red.className).toContain("rounded-r-full");
    expect(quotaTextClass()).toContain("text-red-500");
    // Limit half stays gray even when usage is over the limit.
    expect(quotaLimitTextClass()).toContain("text-gray-500");
    expect(quotaLimitTextClass()).toContain("dark:text-gray-400");
    expect(quotaLimitTextClass()).not.toContain("text-red-500");
    expect(quotaLimitTextClass()).not.toContain("text-[#4285F4]");
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
    expect(blue.className).toContain("bg-[#4285F4]");
    expect(blue.className).not.toContain("bg-red-500");
    // Full rounding kept — no segment join anymore.
    expect(blue.className).toContain("rounded-full");
    expect(blue.className).not.toContain("rounded-l-full");
    expect(screen.queryByTestId("storage-quota-bar-red")).toBeNull();
    expect(quotaTextClass()).toContain("text-[#4285F4]");
    expect(quotaTextClass()).not.toContain("text-red-500");
    // Limit half is always neutral gray, regardless of usage state.
    expect(quotaLimitTextClass()).toContain("text-gray-500");
    expect(quotaLimitTextClass()).toContain("dark:text-gray-400");
    expect(quotaLimitTextClass()).not.toContain("text-[#4285F4]");
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
    expect(blue.className).toContain("bg-[#4285F4]");
    expect(blue.className).not.toContain("bg-red-500");
    expect(blue.className).toContain("rounded-l-full");
    expect(red.style.width).toBe("10%");
    expect(red.className).toContain("bg-red-500");
    expect(red.className).toContain("rounded-r-full");
    expect(quotaTextClass()).toContain("text-red-500");
    expect(quotaTextClass()).not.toContain("text-[#4285F4]");
    // Limit half is always neutral gray, regardless of usage state.
    expect(quotaLimitTextClass()).toContain("text-gray-500");
    expect(quotaLimitTextClass()).toContain("dark:text-gray-400");
    expect(quotaLimitTextClass()).not.toContain("text-[#4285F4]");
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
    expect(bar.className).toContain("bg-[#4285F4]");
    expect(bar.className).toContain("rounded-full");
    expect(screen.queryByTestId("storage-quota-bar-red")).toBeNull();
    expect(quotaTextClass()).toContain("text-[#4285F4]");
    expect(quotaTextClass()).not.toContain("text-red-500");
    // Limit half is always neutral gray, regardless of usage state.
    expect(quotaLimitTextClass()).toContain("text-gray-500");
    expect(quotaLimitTextClass()).toContain("dark:text-gray-400");
    expect(quotaLimitTextClass()).not.toContain("text-[#4285F4]");
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
    expect(blue.className).toContain("bg-[#4285F4]");
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

describe('Sidebar UploadButton (header "+")', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  // Uploads only make sense while My Drive is active — these tests pin the
  // active tab so the button is enabled (title = upload.button_title).
  const myDriveProps = { activeTab: "My Drive", token: "tok-1" } as const;

  it("renders the UploadButton when the sidebar is expanded", () => {
    render(<Sidebar {...baseProps(myDriveProps)} />);
    expect(screen.getByTitle("Upload")).toBeTruthy();
  });

  it("hides the UploadButton when the sidebar is collapsed", () => {
    render(
      <Sidebar
        {...baseProps({
          isSidebarOpen: false,
          token: "tok-1",
          activeTab: "My Drive",
        })}
      />,
    );
    expect(screen.queryByTitle("Upload")).toBeNull();
  });

  it("pushes the upload button to the right of the header via an ml-auto wrapper (centered against the heading, not trailing the DrPlay text)", () => {
    render(<Sidebar {...baseProps(myDriveProps)} />);
    const btn = screen.getByTitle("Upload");
    // The button itself lives inside UploadButton's own div — the ml-auto
    // wrapper sits between it and the header <h1>.
    expect(btn.closest(".ml-auto")).not.toBeNull();
  });

  it("keeps the upload wrapper inside the header padding (no negative margin — button stays within px-7, vertically centered)", () => {
    render(<Sidebar {...baseProps(myDriveProps)} />);
    const btn = screen.getByTitle("Upload");
    const wrapper = btn.closest(".ml-auto");
    expect(wrapper).not.toBeNull();
    if (wrapper) {
      expect(wrapper.className).toContain("flex items-center");
      expect(wrapper.className).not.toContain("-mr-3");
    }
  });

  it("renders no UploadButton when not logged in (no token), even expanded", () => {
    render(<Sidebar {...baseProps({ token: null })} />);
    expect(screen.queryByTitle("Upload")).toBeNull();
  });

  it("dims the UploadButton and disables it while a non-MyDrive tab is active", () => {
    render(<Sidebar {...baseProps({ activeTab: "Liked Songs" })} />);
    // The i18n mock resolves t(key, fallback) to the fallback string.
    const btn = screen.getByTitle("Open My Drive to upload");
    expect(btn.className).toContain("opacity-40");
    expect(btn.className).toContain("cursor-not-allowed");
    expect(btn.getAttribute("aria-disabled")).toBe("true");
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
    expect(letter.className).toContain("text-[#4285F4]");
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

  it("pushes the playlist + button to the row right edge (justify-between) when expanded, aligning it with the header upload +", () => {
    render(<Sidebar {...baseProps({ token: "tok-1" })} />);
    const btn = screen.getByTitle("Create Playlist");
    // The button's parent is the playlist row container.
    const row = btn.parentElement;
    expect(row).not.toBeNull();
    if (row) {
      expect(row.className).toContain("justify-between");
    }
    // Expanded: no ml-3 spacer (justify-between distributes the space instead).
    expect(btn.className).not.toContain("ml-3");
  });

  it("keeps the legacy collapsed layout (no justify-between, button keeps ml-3)", () => {
    render(
      <Sidebar {...baseProps({ isSidebarOpen: false, token: "tok-1" })} />,
    );
    const btn = screen.getByTitle("Create Playlist");
    const row = btn.parentElement;
    expect(row).not.toBeNull();
    if (row) {
      expect(row.className).not.toContain("justify-between");
    }
    expect(btn.className).toContain("ml-3");
  });
});
