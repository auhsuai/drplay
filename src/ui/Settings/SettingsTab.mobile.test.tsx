// @vitest-environment jsdom
// Mobile gate for the seed import section (Task 2 mobile-polish): on
// IS_MOBILE the "Import metadata backup" row must not render at all — no
// button to click, so import_metadata_seed can never be invoked. Desktop
// keeps the section (regression check below, plus SettingsTab.test.tsx).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { ThemeType } from "../../hooks/useTheme";
import { SettingsTab } from "./SettingsTab";
import en from "../../locales/en/translation.json";

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
};

const IMPORT_SEED_LABEL = "Import metadata backup (seed.zip)";
const TRAY_LABEL = "Minimize to System Tray";
const BACKGROUND_PLAYBACK_LABEL = "Background playback";

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
