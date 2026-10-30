// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
  within,
  act,
} from "@testing-library/react";
import type { ThemeType } from "../../hooks/useTheme";
import { SettingsTab } from "./SettingsTab";
import en from "../../locales/en/translation.json";
import { clearAppCache, getCacheSizes } from "../../utils/cache";
import { open } from "@tauri-apps/plugin-dialog";

// react-i18next has no initialized instance in the node test env (i18n.ts
// touches localStorage at import time), so we stub useTranslation to return
// the defaultValue passed to t().
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
      // i18next's t(key, options) shape: the second argument carries the
      // interpolation vars ({metadata: 5}). A string second arg is the
      // defaultValue fallback (kept for compatibility with old call sites).
      t: (key: string, options?: Record<string, string | number> | string) => {
        const resolved =
          resolveKey(key) ?? (typeof options === "string" ? options : key);
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

const showErrorToast = vi.fn();
const showSuccessToast = vi.fn();
vi.mock("../../utils/simpleToast", () => ({
  showErrorToast: (msg: string) => {
    showErrorToast(msg);
  },
  showSuccessToast: (msg: string) => {
    showSuccessToast(msg);
  },
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

const getEffectiveDownloadPath = vi.fn<() => Promise<string>>();
const setCustomDownloadPath = vi.fn();
vi.mock("../../utils/downloadPath", () => ({
  getEffectiveDownloadPath: () => getEffectiveDownloadPath(),
  setCustomDownloadPath: (path: string) => {
    setCustomDownloadPath(path);
  },
}));

// SettingsTab routes download-path load failures into captureError — mock it
// so the reject path is asserted without touching IndexedDB.
const captureErrorMocks = vi.hoisted(() => ({ captureError: vi.fn() }));
vi.mock("../../utils/errorLog", () => ({
  captureError: captureErrorMocks.captureError,
}));

// Child sections pull in heavy dependencies (IndexedDB, i18n) — stub them out
// so this test stays focused on the download-path display.
vi.mock("./components/LanguageDropdown", () => ({
  LanguageDropdown: () => null,
}));
vi.mock("./components/ThemeDropdown", () => ({ ThemeDropdown: () => null }));
vi.mock("./components/CreditsSection", () => ({ CreditsSection: () => null }));
vi.mock("./components/ErrorLogSection", () => ({
  ErrorLogSection: () => null,
}));
// The optional fallback-engine row queries its status on mount, which would
// otherwise show up in the global captureError counts this file asserts on for
// the download-path flows. It has its own integration coverage
// (FallbackEngineSection.test.tsx mounts the real SettingsTab), so stub it
// here exactly like the other child sections.
vi.mock("./components/FallbackEngineSection", () => ({
  FallbackEngineSection: () => null,
}));

const LONG_PATH = "C:\\Users\\thinkpad\\Desktop\\Antigravity\\drplay\\Music";
const SHORT_PATH = "C:\\Music";

const baseProps = {
  theme: "dark" as ThemeType,
  setTheme: vi.fn(),
  minimizeToTray: false,
  setMinimizeToTray: vi.fn(),
  setShowFolderSelection: vi.fn(),
  setShowTrashScreen: vi.fn(),
  configSync: null,
  onRetryConfigSync: vi.fn<() => Promise<void>>(),
};

describe("SettingsTab download path display", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    getEffectiveDownloadPath.mockReset();
    captureErrorMocks.captureError.mockReset();
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

  it("logs the failure and keeps the path empty when resolving the download path rejects", async () => {
    getEffectiveDownloadPath.mockRejectedValue(new Error("invoke failed"));
    render(<SettingsTab {...baseProps} />);
    await waitFor(() => {
      expect(captureErrorMocks.captureError).toHaveBeenCalledTimes(1);
    });
    expect(captureErrorMocks.captureError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        source: "SettingsTab",
        message: expect.stringContaining(
          "download-path-load-failed",
        ) as unknown as string,
      }),
    );
    const el = document.querySelector('p[title=""]');
    expect(el).not.toBeNull();
    expect(el?.textContent).toBe("");
  });
});

describe("SettingsTab download path picker", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.mocked(open).mockReset();
    getEffectiveDownloadPath.mockReset();
    getEffectiveDownloadPath.mockResolvedValue("");
    setCustomDownloadPath.mockReset();
    showErrorToast.mockReset();
    captureErrorMocks.captureError.mockReset();
  });

  it("ignores a second click while the folder dialog is still open", async () => {
    let resolveOpen: (value: string | null) => void = () => {};
    vi.mocked(open).mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          resolveOpen = resolve;
        }),
    );
    render(<SettingsTab {...baseProps} />);
    const button = screen.getByRole<HTMLButtonElement>("button", {
      name: "Change Path",
    });

    fireEvent.click(button);
    fireEvent.click(button);
    await act(async () => {});
    expect(vi.mocked(open)).toHaveBeenCalledTimes(1);
    // The button is disabled while the native dialog is open.
    expect(button.disabled).toBe(true);

    await act(async () => {
      resolveOpen(null);
      await Promise.resolve();
    });
    expect(vi.mocked(open)).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(false);
    expect(showErrorToast).not.toHaveBeenCalled();
    expect(setCustomDownloadPath).not.toHaveBeenCalled();
  });

  it("writes the picked path and shows it once the dialog resolves", async () => {
    vi.mocked(open).mockResolvedValue("C:\\NewMusic");
    render(<SettingsTab {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Change Path" }));
    await waitFor(() => {
      expect(setCustomDownloadPath).toHaveBeenCalledWith("C:\\NewMusic");
    });
    expect(await screen.findByTitle("C:\\NewMusic")).toBeTruthy();
  });

  it("logs and toasts when the folder dialog fails", async () => {
    vi.mocked(open).mockRejectedValue(new Error("dialog exploded"));
    render(<SettingsTab {...baseProps} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Change Path" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(captureErrorMocks.captureError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        source: "SettingsTab",
        message: expect.stringContaining(
          "open-download-folder-dialog-failed",
        ) as unknown as string,
      }),
    );
    expect(showErrorToast).toHaveBeenCalledWith(
      "Couldn't select folder. Try again.",
    );
  });
});

describe("SettingsTab clear cache button", () => {
  afterEach(() => {
    cleanup();
  });

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

describe("SettingsTab metadata fetch toggle", () => {
  const KEY = "drplay_metadata_fetch_enabled";

  beforeEach(() => {
    localStorage.clear();
    getEffectiveDownloadPath.mockReset();
    getEffectiveDownloadPath.mockResolvedValue("");
    captureErrorMocks.captureError.mockReset();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("renders the toggle checked by default when storage is empty", () => {
    render(<SettingsTab {...baseProps} />);
    const checkbox = screen.getByRole<HTMLInputElement>("checkbox", {
      name: "Fetch metadata",
    });
    expect(checkbox.checked).toBe(true);
  });

  it("persists OFF to localStorage when toggled off", () => {
    render(<SettingsTab {...baseProps} />);
    const checkbox = screen.getByRole<HTMLInputElement>("checkbox", {
      name: "Fetch metadata",
    });

    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);
    expect(localStorage.getItem(KEY)).toBe("false");
  });

  it("renders unchecked when storage already says 'false'", () => {
    localStorage.setItem(KEY, "false");
    render(<SettingsTab {...baseProps} />);
    const checkbox = screen.getByRole<HTMLInputElement>("checkbox", {
      name: "Fetch metadata",
    });
    expect(checkbox.checked).toBe(false);
  });
});

// Acceptance criterion 6: an unconfirmed cloud write must stay recoverable from
// the UI. Before this row existed the only feedback was a 4-second toast, and
// the user had to re-pick every root to retry.
describe("SettingsTab config sync retry row", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the unsaved warning and the retry button when configSync is unsaved", () => {
    render(<SettingsTab {...baseProps} configSync="unsaved" />);

    expect(screen.getByTestId("config-sync-unsaved")).toBeTruthy();
    expect(screen.getByTestId("config-sync-retry")).toBeTruthy();
    expect(
      screen.getByText(
        "Saved on this device, but Google Drive wasn't updated.",
      ),
    ).toBeTruthy();
  });

  it("calls onRetryConfigSync exactly once and keeps the button disabled until it settles", async () => {
    let resolveRetry: () => void = () => {};
    const onRetryConfigSync = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRetry = resolve;
        }),
    );
    render(
      <SettingsTab
        {...baseProps}
        configSync="unsaved"
        onRetryConfigSync={onRetryConfigSync}
      />,
    );

    const button = screen.getByTestId<HTMLButtonElement>("config-sync-retry");
    expect(button.disabled).toBe(false);

    fireEvent.click(button);

    await waitFor(() => {
      expect(onRetryConfigSync).toHaveBeenCalledTimes(1);
    });
    // Still pending: the button must stay disabled (no double submit).
    expect(
      screen.getByTestId<HTMLButtonElement>("config-sync-retry").disabled,
    ).toBe(true);

    await act(async () => {
      resolveRetry();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(
        screen.getByTestId<HTMLButtonElement>("config-sync-retry").disabled,
      ).toBe(false);
    });
    expect(onRetryConfigSync).toHaveBeenCalledTimes(1);
  });

  it("hides the row when configSync is saved", () => {
    render(<SettingsTab {...baseProps} configSync="saved" />);

    expect(screen.queryByTestId("config-sync-unsaved")).toBeNull();
    expect(screen.queryByTestId("config-sync-retry")).toBeNull();
  });

  it("hides the row when configSync is null (no commit attempted)", () => {
    render(<SettingsTab {...baseProps} configSync={null} />);

    expect(screen.queryByTestId("config-sync-unsaved")).toBeNull();
    expect(screen.queryByTestId("config-sync-retry")).toBeNull();
  });
});
