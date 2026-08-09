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
import { readFileSync } from "node:fs";
import type { ThemeType } from "../../hooks/useTheme";
import { SettingsTab } from "./SettingsTab";
import en from "../../locales/en/translation.json";
import { clearAppCache, getCacheSizes } from "../../utils/cache";
import type { UploadEntry } from "../../utils/uploadManager";

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
      t: (key: string, defaultValue?: string) =>
        resolveKey(key) ?? defaultValue ?? key,
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
vi.mock("../../utils/downloadPath", () => ({
  getEffectiveDownloadPath: () => getEffectiveDownloadPath(),
  setCustomDownloadPath: vi.fn(),
}));

// SettingsTab routes download-path load failures into captureError — mock it
// so the reject path is asserted without touching IndexedDB.
const captureErrorMocks = vi.hoisted(() => ({ captureError: vi.fn() }));
vi.mock("../../utils/errorLog", () => ({
  captureError: captureErrorMocks.captureError,
}));

// The in-progress uploads section (slice 5.3) consumes uploadManager's
// subscribe/getEntries/cancelUpload — mocked here so the section's behavior
// (render/hide/cancel/live updates) is tested in isolation from the real
// IndexedDB-backed manager.
const uploadManagerMocks = vi.hoisted(() => ({
  subscribe: vi.fn<(cb: () => void) => () => void>(() => () => {}),
  getEntries: vi.fn<() => UploadEntry[]>(() => []),
  cancelUpload: vi.fn(),
}));
vi.mock("../../utils/uploadManager", () => uploadManagerMocks);

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

describe("SettingsTab in-progress uploads section", () => {
  let notifySubscriber: () => void;
  const unsubscribe = vi.fn();
  const UPLOADING_ENTRY: UploadEntry = {
    id: "pending-1",
    name: "Song A.flac",
    isFolder: false,
    parentId: "root",
    status: "uploading",
    progress: 0.5,
  };

  beforeEach(() => {
    uploadManagerMocks.subscribe.mockReset();
    uploadManagerMocks.getEntries.mockReset();
    uploadManagerMocks.cancelUpload.mockReset();
    unsubscribe.mockClear();
    uploadManagerMocks.getEntries.mockReturnValue([]);
    uploadManagerMocks.subscribe.mockImplementation((cb: () => void) => {
      notifySubscriber = cb;
      return unsubscribe;
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("hides the section entirely when no entries are queued/uploading", () => {
    // done/error entries alone must not render the section (filter contract).
    uploadManagerMocks.getEntries.mockReturnValue([
      {
        id: "pending-done",
        name: "Done.flac",
        isFolder: false,
        parentId: "root",
        status: "done",
      },
      {
        id: "pending-err",
        name: "Err.flac",
        isFolder: false,
        parentId: "root",
        status: "error",
        error: "aborted",
      },
    ]);
    render(<SettingsTab {...baseProps} />);
    expect(screen.queryByText("In-progress uploads")).toBeNull();
    expect(screen.queryByText("Done.flac")).toBeNull();
  });

  it("shows an uploading entry with its name, live percent and a cancel button", () => {
    uploadManagerMocks.getEntries.mockReturnValue([UPLOADING_ENTRY]);
    render(<SettingsTab {...baseProps} />);
    expect(screen.getByText("In-progress uploads")).toBeTruthy();
    expect(screen.getByText("Song A.flac")).toBeTruthy();
    expect(screen.getByText("50%")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("shows 'Queued...' instead of a percent for a queued entry", () => {
    uploadManagerMocks.getEntries.mockReturnValue([
      {
        ...UPLOADING_ENTRY,
        id: "pending-2",
        name: "Song B.mp3",
        status: "queued",
      },
    ]);
    render(<SettingsTab {...baseProps} />);
    expect(screen.getByText("Song B.mp3")).toBeTruthy();
    expect(screen.getByText("Queued...")).toBeTruthy();
    expect(screen.queryByText("0%")).toBeNull();
  });

  it("calls cancelUpload with the exact entry id when cancel is clicked", () => {
    const entryId = "pending-7";
    uploadManagerMocks.getEntries.mockReturnValue([
      { ...UPLOADING_ENTRY, id: entryId },
    ]);
    render(<SettingsTab {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(uploadManagerMocks.cancelUpload).toHaveBeenCalledTimes(1);
    expect(uploadManagerMocks.cancelUpload).toHaveBeenCalledWith(entryId);
  });

  it("subscribes on mount and re-renders live when the manager notifies", () => {
    render(<SettingsTab {...baseProps} />);
    expect(uploadManagerMocks.subscribe).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("In-progress uploads")).toBeNull();
    // The manager pushes a new entry → notify fires → section appears.
    uploadManagerMocks.getEntries.mockReturnValue([
      {
        ...UPLOADING_ENTRY,
        id: "pending-9",
        name: "Song C.wav",
        progress: 0.25,
      },
    ]);
    act(() => {
      notifySubscriber();
    });
    expect(screen.getByText("Song C.wav")).toBeTruthy();
    expect(screen.getByText("25%")).toBeTruthy();
  });

  it("unsubscribes on unmount (no leaked subscriber)", () => {
    const { unmount } = render(<SettingsTab {...baseProps} />);
    expect(unsubscribe).not.toHaveBeenCalled();
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe("SettingsTab uploads section i18n keys", () => {
  it("defines settings.uploads_section and settings.uploads_cancel in en and vi", () => {
    for (const lang of ["en", "vi"]) {
      const json = JSON.parse(
        readFileSync(`src/locales/${lang}/translation.json`, "utf8"),
      ) as { settings: Record<string, string> };
      expect(json.settings.uploads_section?.trim().length).toBeGreaterThan(0);
      expect(json.settings.uploads_cancel?.trim().length).toBeGreaterThan(0);
    }
  });
});
