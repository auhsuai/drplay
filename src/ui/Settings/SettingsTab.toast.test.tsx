// @vitest-environment jsdom
// Integration test: real simpleToast + a #content-area container (as AppShell
// provides in production). Verifies the full chain SettingsTab click →
// showSuccessToast → toast element appended to #content-area. This catches
// regressions where the success branch calls the wrong toast function.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
  within,
} from "@testing-library/react";
import type { ThemeType } from "../../hooks/useTheme";
import { SettingsTab } from "./SettingsTab";
import en from "../../locales/en/translation.json";
import { clearAppCache, getCacheSizes } from "../../utils/cache";

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

// The uploads section (slice 5.3) imports uploadManager, which transitively
// pulls Tauri APIs (diskFs) that must not load in the jsdom env — the section
// is covered in SettingsTab.test.tsx, so a minimal mock keeps this file
// focused on the cache-toast flow.
vi.mock("../../utils/uploadManager", () => ({
  subscribe: () => () => {},
  getEntries: () => [],
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

describe("Clear Cache flow renders a real success toast", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="content-area"></div>';
    vi.mocked(clearAppCache).mockReset();
    vi.mocked(clearAppCache).mockResolvedValue(undefined);
    vi.mocked(getCacheSizes).mockReset();
    vi.mocked(getCacheSizes).mockResolvedValue([
      { id: "metadata", label: "Metadata cache", bytes: 1024 },
      { id: "files", label: "File listing cache", bytes: 2048 },
      { id: "covers", label: "Covers & thumbnails", bytes: 0 },
      { id: "prefetch", label: "Prefetched data", bytes: 1536 },
    ]);
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  it("appends an .app-toast--success element into #content-area after confirming in the modal", async () => {
    render(<SettingsTab {...baseProps} />);
    // Settings trigger → modal opens (all categories default-checked).
    fireEvent.click(screen.getByRole("button", { name: "Clear Cache" }));
    const modal = await screen.findByTestId("cache-manager-modal");
    await screen.findByText("Metadata cache");
    fireEvent.click(within(modal).getByRole("button", { name: "Clear Cache" }));

    await waitFor(() => {
      const successToast = document.querySelector(".app-toast--success");
      expect(successToast).not.toBeNull();
      expect(successToast?.textContent).toBe("Cache cleared");
    });
    expect(document.querySelector(".app-toast--error")).toBeNull();
  });
});
