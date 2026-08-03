// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, within } from "@testing-library/react";
import type { ThemeType } from "../../hooks/useTheme";
import { SettingsTab } from "./SettingsTab";
import { clearAppCache, getCacheSizes } from "../../utils/cache";

// react-i18next has no initialized instance in the node test env (i18n.ts
// touches localStorage at import time), so we stub useTranslation to return
// the defaultValue passed to t().
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, defaultValue?: string) => defaultValue ?? _key,
  }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const showErrorToast = vi.fn();
const showSuccessToast = vi.fn();
vi.mock("../../utils/simpleToast", () => ({
  showErrorToast: (msg: string) => showErrorToast(msg),
  showSuccessToast: (msg: string) => showSuccessToast(msg),
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

const getEffectiveDownloadPath = vi.fn();
vi.mock("../../utils/downloadPath", () => ({
  getEffectiveDownloadPath: () => getEffectiveDownloadPath(),
  setCustomDownloadPath: vi.fn(),
}));

// Child sections pull in heavy dependencies (IndexedDB, i18n) — stub them out
// so this test stays focused on the download-path display.
vi.mock("./components/LanguageDropdown", () => ({ LanguageDropdown: () => null }));
vi.mock("./components/ThemeDropdown", () => ({ ThemeDropdown: () => null }));
vi.mock("./components/CreditsSection", () => ({ CreditsSection: () => null }));
vi.mock("./components/ErrorLogSection", () => ({ ErrorLogSection: () => null }));

const LONG_PATH = "C:\\Users\\thinkpad\\Desktop\\Antigravity\\drplay\\Music";
const SHORT_PATH = "C:\\Music";

const baseProps = {
  theme: "dark" as ThemeType,
  setTheme: vi.fn(),
  minimizeToTray: false,
  setMinimizeToTray: vi.fn(),
  setShowFolderSelection: vi.fn(),
  setShowTrashScreen: vi.fn(),
};

describe("SettingsTab download path display", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    getEffectiveDownloadPath.mockReset();
  });

  it("exposes the full path via title while showing the middle-truncated path", async () => {
    getEffectiveDownloadPath.mockResolvedValue(LONG_PATH);
    render(<SettingsTab {...baseProps} />);
    const el = await screen.findByTitle(LONG_PATH);
    expect(el.textContent).toContain("…");
    expect(el.textContent).toContain("Music");
    expect(el.textContent).not.toContain("Antigravity");
  });

  it("renders short paths unchanged", async () => {
    getEffectiveDownloadPath.mockResolvedValue(SHORT_PATH);
    render(<SettingsTab {...baseProps} />);
    const el = await screen.findByTitle(SHORT_PATH);
    expect(el.textContent).toBe(SHORT_PATH);
    expect(el.textContent).not.toContain("…");
  });

  it("renders an empty path as empty text", async () => {
    getEffectiveDownloadPath.mockResolvedValue("");
    render(<SettingsTab {...baseProps} />);
    await waitFor(() => {
      const el = document.querySelector('p[title=""]');
      expect(el).not.toBeNull();
      expect(el?.textContent).toBe("");
    });
  });
});

describe("SettingsTab clear cache button", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    showErrorToast.mockReset();
    showSuccessToast.mockReset();
    vi.mocked(clearAppCache).mockReset();
    vi.mocked(getCacheSizes).mockReset();
    vi.mocked(getCacheSizes).mockResolvedValue([
      { id: "metadata", label: "Metadata cache", bytes: 1024 },
      { id: "files", label: "File listing cache", bytes: 2048 },
      { id: "covers", label: "Covers & thumbnails", bytes: 0 },
      { id: "prefetch", label: "Prefetched data", bytes: 1536 },
    ]);
  });

  it("opens the cache manager modal instead of clearing directly", async () => {
    render(<SettingsTab {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear Cache" }));
    const modal = await screen.findByTestId("cache-manager-modal");
    expect(within(modal).getByText("Clear App Cache")).toBeTruthy();
    // The old direct-clear path is gone: nothing is cleared until the modal's
    // own Clear button is pressed.
    expect(clearAppCache).not.toHaveBeenCalled();
    expect(showSuccessToast).not.toHaveBeenCalled();
  });
});
