// @vitest-environment jsdom
// Integration test: real simpleToast + a #toast-root container (as App.tsx
// provides in production). Verifies the full chain SettingsTab click →
// showSuccessToast → toast element appended to #toast-root. This catches
// regressions where the success branch calls the wrong toast function.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import type { ThemeType } from "../../hooks/useTheme";
import { SettingsTab } from "./SettingsTab";
import { clearAppCache } from "../../utils/cache";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, defaultValue?: string) => defaultValue ?? _key,
  }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

vi.mock("../../utils/cache", () => ({ clearAppCache: vi.fn() }));

vi.mock("../../utils/downloadPath", () => ({
  getEffectiveDownloadPath: vi.fn().mockResolvedValue(""),
  setCustomDownloadPath: vi.fn(),
}));

vi.mock("./components/LanguageDropdown", () => ({ LanguageDropdown: () => null }));
vi.mock("./components/ThemeDropdown", () => ({ ThemeDropdown: () => null }));
vi.mock("./components/CreditsSection", () => ({ CreditsSection: () => null }));
vi.mock("./components/ErrorLogSection", () => ({ ErrorLogSection: () => null }));

const baseProps = {
  theme: "dark" as ThemeType,
  setTheme: vi.fn(),
  minimizeToTray: false,
  setMinimizeToTray: vi.fn(),
  setShowFolderSelection: vi.fn(),
  setShowTrashScreen: vi.fn(),
};

describe("Clear Now button renders a real success toast", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="toast-root"></div>';
    vi.mocked(clearAppCache).mockReset();
    vi.mocked(clearAppCache).mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  it("appends an .app-toast--success element into #toast-root", async () => {
    render(<SettingsTab {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear Now" }));

    await waitFor(() => {
      const successToast = document.querySelector(".app-toast--success");
      expect(successToast).not.toBeNull();
      expect(successToast?.textContent).toBe("Cache cleared successfully!");
    });
    expect(document.querySelector(".app-toast--error")).toBeNull();
  });
});
