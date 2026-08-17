// @vitest-environment jsdom
// Mobile gate for the seed import section (Task 2 mobile-polish): on
// IS_MOBILE the "Import metadata backup" row must not render at all — no
// button to click, so import_metadata_seed can never be invoked. Desktop
// keeps the section (regression check below, plus SettingsTab.test.tsx).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import type { ThemeType } from "../../hooks/useTheme";
import { SettingsTab } from "./SettingsTab";
import en from "../../locales/en/translation.json";
import { invoke } from "@tauri-apps/api/core";
import { showErrorToast } from "../../utils/simpleToast";
import {
  getMobileDownloadFolder,
  setMobileDownloadFolder,
} from "../../utils/downloadPath";

// Getter-backed platform mock: SettingsTab reads IS_MOBILE at render time,
// so each test can toggle the platform (same pattern as LoginScreen.test.tsx).
const platformMock = vi.hoisted(() => ({ IS_MOBILE: false }));
vi.mock("../../utils/platform", () => ({
  get IS_MOBILE() {
    return platformMock.IS_MOBILE;
  },
}));

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
      i18n: { language: "en" },
      t: (key: string, options?: Record<string, string | number> | string) => {
        const fallback =
          typeof options === "object" ? options.defaultValue : options;
        const resolved =
          resolveKey(key) ?? (typeof fallback === "string" ? fallback : key);
        if (typeof options === "object") {
          return resolved.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
            String(options[name] ?? `{{${name}}}`),
          );
        }
        return resolved;
      },
    }),
  };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

vi.mock("../../utils/simpleToast", () => ({
  showErrorToast: vi.fn(),
  showSuccessToast: vi.fn(),
}));

vi.mock("../../utils/cache", () => ({
  clearAppCache: vi.fn(),
  getCacheSizes: vi.fn(),
  CACHE_CATEGORY_LABELS: {
    metadata: "Metadata cache",
    files: "File listing cache",
    covers: "Covers & thumbnails",
    prefetch: "Prefetched data",
  },
}));

vi.mock("../../utils/downloadPath", () => ({
  getEffectiveDownloadPath: vi.fn().mockResolvedValue(""),
  setCustomDownloadPath: vi.fn(),
  getMobileDownloadFolder: vi.fn().mockReturnValue(null),
  setMobileDownloadFolder: vi.fn(),
}));

vi.mock("../../utils/errorLog", () => ({ captureError: vi.fn() }));

vi.mock("../../utils/uploadManager", () => ({
  subscribe: vi.fn(() => () => {}),
  getEntries: vi.fn(() => []),
  cancelUpload: vi.fn(),
}));

vi.mock("./components/LanguageDropdown", () => ({
  LanguageDropdown: () => null,
}));
vi.mock("./components/ThemeDropdown", () => ({ ThemeDropdown: () => null }));
vi.mock("./components/CreditsSection", () => ({ CreditsSection: () => null }));
vi.mock("./components/ErrorLogSection", () => ({
  ErrorLogSection: () => null,
}));

const baseProps = {
  theme: "dark" as ThemeType,
  setTheme: vi.fn(),
  minimizeToTray: false,
  setMinimizeToTray: vi.fn(),
  backgroundPlayback: true,
  setBackgroundPlayback: vi.fn(),
  setShowFolderSelection: vi.fn(),
  setShowTrashScreen: vi.fn(),
  userProfile: null,
  onLogout: vi.fn(),
};

const IMPORT_SEED_LABEL = "Import metadata backup (seed.zip)";
const TRAY_LABEL = "Minimize to System Tray";
const BACKGROUND_PLAYBACK_LABEL = "Background playback";
const CHANGE_PATH_LABEL = "Change Path";
const DEFAULT_LOCATION_LABEL = "App storage (default)";

const mockedInvoke = vi.mocked(invoke);
const mockedGetMobileDownloadFolder = vi.mocked(getMobileDownloadFolder);
const mockedSetMobileDownloadFolder = vi.mocked(setMobileDownloadFolder);
const mockedShowErrorToast = vi.mocked(showErrorToast);

describe("SettingsTab seed import section (mobile hidden)", () => {
  beforeEach(() => {
    platformMock.IS_MOBILE = false;
  });

  afterEach(() => {
    cleanup();
  });

  it("does not render the import section on mobile (IS_MOBILE=true)", () => {
    platformMock.IS_MOBILE = true;
    render(<SettingsTab {...baseProps} />);
    // The label appears twice on desktop (row text + button); on mobile it
    // must be absent entirely so no import_metadata_seed invoke is reachable.
    expect(screen.queryAllByText(IMPORT_SEED_LABEL)).toHaveLength(0);
    expect(
      screen.queryByRole("button", { name: IMPORT_SEED_LABEL }),
    ).toBeNull();
  });

  it("keeps the import section on desktop (IS_MOBILE=false)", () => {
    platformMock.IS_MOBILE = false;
    render(<SettingsTab {...baseProps} />);
    expect(screen.getAllByText(IMPORT_SEED_LABEL)).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: IMPORT_SEED_LABEL }),
    ).toBeTruthy();
  });
});

// Task 3 mobile-polish: the close-behavior row swaps the tray toggle for the
// "Chạy nhạc nền" (background playback) toggle on mobile. Desktop keeps the
// tray row untouched; mobile must never render it (and vice versa).
describe("SettingsTab close-behavior toggle (mobile vs desktop)", () => {
  beforeEach(() => {
    platformMock.IS_MOBILE = true;
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the background playback toggle on mobile, no tray row", () => {
    render(<SettingsTab {...baseProps} />);
    // Label appears twice on mobile (row text + sr-only): toggle present.
    expect(screen.getAllByText(BACKGROUND_PLAYBACK_LABEL)).toHaveLength(2);
    expect(screen.queryByText(TRAY_LABEL)).toBeNull();
  });

  it("flips setBackgroundPlayback when the mobile toggle is clicked", () => {
    const setBackgroundPlayback = vi.fn();
    render(
      <SettingsTab
        {...baseProps}
        backgroundPlayback={false}
        setBackgroundPlayback={setBackgroundPlayback}
      />,
    );
    const checkbox = screen.getByRole("checkbox", {
      name: BACKGROUND_PLAYBACK_LABEL,
    });
    expect(checkbox).toBeTruthy();
    fireEvent.click(checkbox);
    expect(setBackgroundPlayback).toHaveBeenCalledWith(true);
  });

  it("renders the tray toggle on desktop, no background playback row", () => {
    platformMock.IS_MOBILE = false;
    render(<SettingsTab {...baseProps} />);
    expect(screen.getAllByText(TRAY_LABEL)).toHaveLength(2);
    expect(screen.queryByText(BACKGROUND_PLAYBACK_LABEL)).toBeNull();
  });

  it("flips setMinimizeToTray when the desktop tray toggle is clicked (regression)", () => {
    platformMock.IS_MOBILE = false;
    const setMinimizeToTray = vi.fn();
    render(
      <SettingsTab
        {...baseProps}
        minimizeToTray={false}
        setMinimizeToTray={setMinimizeToTray}
      />,
    );
    const checkbox = screen.getByRole("checkbox", {
      name: TRAY_LABEL,
    });
    expect(checkbox).toBeTruthy();
    fireEvent.click(checkbox);
    expect(setMinimizeToTray).toHaveBeenCalledWith(true);
  });
});

// Task 4 mobile-polish: the download-location row on mobile drives the SAF
// folder picker (plugin:saf-download|pick_folder) instead of the desktop
// dialog (which has NO Android folder support). Picked folder → persisted +
// name shown; cancel → nothing changes; real failure → error toast.
describe("SettingsTab download folder pick (mobile SAF)", () => {
  beforeEach(() => {
    platformMock.IS_MOBILE = true;
    mockedGetMobileDownloadFolder.mockReturnValue(null);
    mockedSetMobileDownloadFolder.mockReset();
    mockedShowErrorToast.mockReset();
    mockedInvoke.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows the default app-storage label on mobile when no folder is picked", async () => {
    render(<SettingsTab {...baseProps} />);
    expect(await screen.findByText(DEFAULT_LOCATION_LABEL)).toBeTruthy();
  });

  it("shows the picked folder NAME on mobile instead of the internal path", async () => {
    mockedGetMobileDownloadFolder.mockReturnValue({
      uri: "content://tree/primary%3ADownload",
      name: "Download",
    });
    render(<SettingsTab {...baseProps} />);
    expect(await screen.findByText("Download")).toBeTruthy();
  });

  it("picking a folder via the SAF plugin persists {uri, name} and updates the row", async () => {
    mockedInvoke.mockResolvedValue({
      uri: "content://tree/primary%3AMusic",
      name: "Music",
    });
    render(<SettingsTab {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: CHANGE_PATH_LABEL }));

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        "plugin:saf-download|pick_folder",
      );
    });
    expect(mockedSetMobileDownloadFolder).toHaveBeenCalledWith({
      uri: "content://tree/primary%3AMusic",
      name: "Music",
    });
    expect(await screen.findByText("Music")).toBeTruthy();
  });

  it("user cancelling the SAF picker changes nothing (no persist, no toast)", async () => {
    mockedInvoke.mockRejectedValue({ message: "cancelled" });
    render(<SettingsTab {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: CHANGE_PATH_LABEL }));

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        "plugin:saf-download|pick_folder",
      );
    });
    expect(mockedSetMobileDownloadFolder).not.toHaveBeenCalled();
    expect(mockedShowErrorToast).not.toHaveBeenCalled();
  });

  it("a real picker failure surfaces the error toast", async () => {
    mockedInvoke.mockRejectedValue({ message: "pick_failed:no_uri" });
    render(<SettingsTab {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: CHANGE_PATH_LABEL }));

    await waitFor(() => {
      expect(mockedShowErrorToast).toHaveBeenCalledWith(
        "Couldn't select folder. Try again.",
      );
    });
    expect(mockedSetMobileDownloadFolder).not.toHaveBeenCalled();
  });
});

describe("SettingsTab font compaction (Task 8)", () => {
  beforeEach(() => {
    platformMock.IS_MOBILE = true;
  });

  afterEach(() => {
    platformMock.IS_MOBILE = false;
    cleanup();
  });

  it("compacts the h1 title to text-xl on mobile (Task 9 second notch)", () => {
    const { container } = render(<SettingsTab {...baseProps} />);
    const h1 = container.querySelector("h1");
    expect(h1?.className).toContain("text-xl");
    expect(h1?.className).not.toContain("text-2xl");
    expect(h1?.className).not.toContain("text-3xl");
  });

  it("compacts setting row titles to text-[13px] on mobile (Task 9 second notch)", () => {
    const { container } = render(<SettingsTab {...baseProps} />);
    expect(container.querySelector("p.text-base")).toBeNull();
    expect(screen.getByText("Google Drive Folder").className).toContain(
      "text-[13px]",
    );
  });

  it("keeps text-3xl h1 and text-base row titles on desktop (byte-identical)", () => {
    platformMock.IS_MOBILE = false;
    const { container } = render(<SettingsTab {...baseProps} />);
    expect(container.querySelector("h1")?.className).toContain("text-3xl");
    expect(container.querySelector("p.text-base")).not.toBeNull();
  });
});

// Task 13 mobile-polish: on mobile the Settings page opens with a user
// header (avatar + name + email) fed from the SAME userProfile prop the
// Sidebar renders from (single source of truth — no second fetch). Desktop
// must stay byte-identical: no header markup at all.
describe("SettingsTab user header (Task 13)", () => {
  const USER = {
    name: "Alice",
    email: "a@b.c",
    picture: "https://example.com/pic.jpg",
  };

  beforeEach(() => {
    platformMock.IS_MOBILE = true;
  });

  afterEach(() => {
    platformMock.IS_MOBILE = false;
    cleanup();
  });

  it("renders the avatar image + name + email on mobile when signed in", () => {
    render(<SettingsTab {...baseProps} userProfile={USER} />);
    expect(screen.getByAltText("Profile")).toBeTruthy();
    expect(screen.getByText("Alice")).toBeTruthy();
    expect(screen.getByText("a@b.c")).toBeTruthy();
    expect(screen.queryByText("?")).toBeNull();
  });

  it("falls back to the initial-letter avatar when the picture fails to load", () => {
    render(<SettingsTab {...baseProps} userProfile={USER} />);
    const img = screen.getByAltText("Profile");
    fireEvent.error(img);
    expect(screen.queryByAltText("Profile")).toBeNull();
    const letter = screen.getByText("A");
    expect(letter.className).toContain("text-brand-primary");
  });

  it("shows the guest avatar + guest labels on mobile when not signed in", () => {
    render(<SettingsTab {...baseProps} userProfile={null} />);
    expect(screen.getByText("?")).toBeTruthy();
    expect(screen.getByText("Guest")).toBeTruthy();
    expect(screen.getByText("Not signed in")).toBeTruthy();
  });

  it("renders NO user header on desktop (byte-identical to pre-task)", () => {
    platformMock.IS_MOBILE = false;
    render(<SettingsTab {...baseProps} userProfile={USER} />);
    expect(screen.queryByAltText("Profile")).toBeNull();
    expect(screen.queryByText("Alice")).toBeNull();
    expect(screen.queryByText("a@b.c")).toBeNull();
  });
});

// Task A: the mobile identity header carries the Sign out button (desktop
// keeps it in the Sidebar only). Click must route through the onLogout prop —
// the same callback App wires to useAuth's handleLogout.
describe("SettingsTab logout button (Task A)", () => {
  const USER = {
    name: "Alice",
    email: "a@b.c",
    picture: "https://example.com/pic.jpg",
  };

  beforeEach(() => {
    platformMock.IS_MOBILE = true;
  });

  afterEach(() => {
    platformMock.IS_MOBILE = false;
    cleanup();
  });

  it("renders the Sign out button in the mobile identity header when signed in", () => {
    render(<SettingsTab {...baseProps} userProfile={USER} />);
    expect(screen.getByTitle("Sign out")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("renders the Sign out button for guests too (userProfile null)", () => {
    render(<SettingsTab {...baseProps} userProfile={null} />);
    expect(screen.getByTitle("Sign out")).toBeTruthy();
  });

  it("calls onLogout when the mobile Sign out button is clicked", () => {
    const onLogout = vi.fn();
    render(<SettingsTab {...baseProps} onLogout={onLogout} />);
    fireEvent.click(screen.getByTitle("Sign out"));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("renders NO logout button on desktop (the Sidebar owns it)", () => {
    platformMock.IS_MOBILE = false;
    render(<SettingsTab {...baseProps} userProfile={USER} />);
    expect(screen.queryByTitle("Sign out")).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });
});
