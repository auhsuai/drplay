// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { CacheManagerModal } from "./CacheManagerModal";
import en from "../../../locales/en/translation.json";
import {
  getCacheSizes,
  clearAppCache,
  getFallbackEngineSize,
  removeFallbackEngine,
  type CacheCategoryId,
  type CacheCategoryInfo,
} from "../../../utils/cache";

// react-i18next has no initialized instance in the node test env, so stub
// useTranslation to return the defaultValue passed to t() (same as
// SettingsTab.test.tsx).
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

vi.mock("lucide-react", () => {
  // Spread props so data-testid from LoaderCircle survives in the DOM.
  const Stub = (props: Record<string, unknown>) => <div {...props} />;
  return { X: Stub, LoaderCircle: Stub, Check: Stub };
});

vi.mock("../../../utils/cache", () => ({
  getCacheSizes: vi.fn(),
  clearAppCache: vi.fn(),
  getFallbackEngineSize: vi.fn(),
  removeFallbackEngine: vi.fn(),
  FALLBACK_ENGINE_ID: "fallback_engine",
  CACHE_CATEGORY_LABELS: {
    metadata: "Metadata cache",
    files: "File listing cache",
    covers: "Covers & thumbnails",
    prefetch: "Prefetched data",
  } satisfies Record<CacheCategoryId, string>,
}));

const captureError = vi.fn();
vi.mock("../../../utils/errorLog", () => ({
  captureError: (input: unknown) => {
    captureError(input);
  },
}));

const showErrorToast = vi.fn();
const showSuccessToast = vi.fn();
vi.mock("../../../utils/simpleToast", () => ({
  showErrorToast: (msg: string) => {
    showErrorToast(msg);
  },
  showSuccessToast: (msg: string) => {
    showSuccessToast(msg);
  },
}));

const SIZES: CacheCategoryInfo[] = [
  { id: "metadata", label: "Metadata cache", bytes: 1024 },
  { id: "files", label: "File listing cache", bytes: 2048 },
  { id: "covers", label: "Covers & thumbnails", bytes: 0 },
  { id: "prefetch", label: "Prefetched data", bytes: 1536 },
];

function renderOpen(onClose = vi.fn()) {
  const utils = render(<CacheManagerModal open onClose={onClose} />);
  return { ...utils, onClose };
}

describe("CacheManagerModal", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.mocked(getCacheSizes).mockReset();
    vi.mocked(clearAppCache).mockReset();
    vi.mocked(getFallbackEngineSize).mockReset();
    vi.mocked(removeFallbackEngine).mockReset();
    vi.mocked(getCacheSizes).mockResolvedValue(SIZES);
    // Default fixture: no fallback engine installed, so the extra row is absent
    // and the pre-existing four-row assertions keep their meaning.
    vi.mocked(getFallbackEngineSize).mockResolvedValue(null);
    vi.mocked(clearAppCache).mockResolvedValue(undefined);
    vi.mocked(removeFallbackEngine).mockResolvedValue(undefined);
    showErrorToast.mockReset();
    showSuccessToast.mockReset();
    captureError.mockReset();
  });

  it("renders nothing when closed", () => {
    const { container } = render(
      <CacheManagerModal open={false} onClose={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("lists all 4 categories with formatted sizes and all checked by default", async () => {
    renderOpen();
    expect(await screen.findByText("Metadata cache")).toBeTruthy();
    expect(screen.getByText("File listing cache")).toBeTruthy();
    expect(screen.getByText("Covers & thumbnails")).toBeTruthy();
    expect(screen.getByText("Prefetched data")).toBeTruthy();

    // Sizes arrive after the fetch resolves: formatBytes(1024) = "1 KB",
    // formatBytes(2048) = "2 KB", formatBytes(0) = "0 B",
    // formatBytes(1536) = "1.5 KB".
    await waitFor(() => {
      expect(screen.getByText("1 KB")).toBeTruthy();
      expect(screen.getByText("2 KB")).toBeTruthy();
      expect(screen.getByText("0 B")).toBeTruthy();
      expect(screen.getByText("1.5 KB")).toBeTruthy();
    });

    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(4);
    expect(checkboxes.every((cb) => (cb as HTMLInputElement).checked)).toBe(
      true,
    );
  });

  it("renders the 4 category rows immediately with per-row size placeholders, then swaps in sizes", async () => {
    // Deferred promise: the modal must not gate the rows on the fetch.
    let resolveSizes!: (v: CacheCategoryInfo[]) => void;
    vi.mocked(getCacheSizes).mockReturnValue(
      new Promise((resolve) => {
        resolveSizes = resolve;
      }),
    );
    renderOpen();

    // Rows render from CACHE_CATEGORY_LABELS right away, no "Loading..." row.
    expect(screen.getByText("Metadata cache")).toBeTruthy();
    expect(screen.getByText("File listing cache")).toBeTruthy();
    expect(screen.getByText("Covers & thumbnails")).toBeTruthy();
    expect(screen.getByText("Prefetched data")).toBeTruthy();
    expect(screen.queryByText("Loading...")).toBeNull();

    // Every row shows a text placeholder in its size slot until the fetch
    // resolves — same text-sm as the real size, so the column never jumps.
    expect(screen.getAllByTestId("size-placeholder")).toHaveLength(4);
    expect(screen.queryByText("1 KB")).toBeNull();

    resolveSizes(SIZES);
    await waitFor(() => {
      expect(screen.queryAllByTestId("size-placeholder")).toHaveLength(0);
    });
    expect(screen.getByText("1 KB")).toBeTruthy();
    expect(screen.getByText("2 KB")).toBeTruthy();
    expect(screen.getByText("0 B")).toBeTruthy();
    expect(screen.getByText("1.5 KB")).toBeTruthy();
  });

  it("uses a custom checkbox with a visible unchecked border (Material-style)", async () => {
    renderOpen();
    await screen.findByText("Metadata cache");
    const first = screen.getAllByRole("checkbox")[0] as HTMLInputElement;
    // appearance-none + gray border are the contract that makes the unchecked
    // state visible instead of the native accent color.
    expect(first.className).toContain("appearance-none");
    expect(first.className).toContain("border-gray-400");
  });

  it("disables the Clear button when every category is unchecked", async () => {
    renderOpen();
    await screen.findByText("Metadata cache");
    const checkboxes = screen.getAllByRole("checkbox");
    checkboxes.forEach((cb) => fireEvent.click(cb));
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Clear Data",
      }).disabled,
    ).toBe(true);
  });

  it("calls clearAppCache with only the still-checked categories", async () => {
    vi.mocked(clearAppCache).mockResolvedValue(undefined);
    renderOpen();
    await screen.findByText("Metadata cache");
    const checkboxes = screen.getAllByRole("checkbox");
    const coversCheckbox = checkboxes[1];
    if (coversCheckbox === undefined) throw new Error("expected checkbox");
    fireEvent.click(coversCheckbox);
    fireEvent.click(screen.getByRole("button", { name: "Clear Data" }));
    await waitFor(() => {
      expect(clearAppCache).toHaveBeenCalledWith([
        "metadata",
        "covers",
        "prefetch",
      ]);
    });
  });

  it("Cancel closes the modal without clearing anything", async () => {
    const onClose = vi.fn();
    renderOpen(onClose);
    await screen.findByText("Metadata cache");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(clearAppCache).not.toHaveBeenCalled();
  });

  it("shows a success toast and closes on successful clear", async () => {
    vi.mocked(clearAppCache).mockResolvedValue(undefined);
    const onClose = vi.fn();
    renderOpen(onClose);
    await screen.findByText("Metadata cache");
    fireEvent.click(screen.getByRole("button", { name: "Clear Data" }));
    await waitFor(() => {
      expect(showSuccessToast).toHaveBeenCalledWith("App data cleared");
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(showErrorToast).not.toHaveBeenCalled();
  });

  it("shows an error toast and stays open when clearing fails", async () => {
    vi.mocked(clearAppCache).mockRejectedValue(new Error("boom"));
    renderOpen();
    await screen.findByText("Metadata cache");
    fireEvent.click(screen.getByRole("button", { name: "Clear Data" }));
    await waitFor(() => {
      expect(showErrorToast).toHaveBeenCalledWith(
        "Couldn't clear app data. Try again.",
      );
    });
    expect(showSuccessToast).not.toHaveBeenCalled();
    expect(screen.getByText("Clear App Data")).toBeTruthy();
  });

  it("closes on Escape keydown", async () => {
    const onClose = vi.fn();
    renderOpen(onClose);
    await screen.findByText("Metadata cache");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on overlay click", async () => {
    const onClose = vi.fn();
    renderOpen(onClose);
    await screen.findByText("Metadata cache");
    fireEvent.click(screen.getByTestId("cache-manager-overlay"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("exposes the visible title as the dialog's accessible name", async () => {
    renderOpen();
    await screen.findByText("Metadata cache");
    expect(screen.getByRole("dialog", { name: "Clear App Data" })).toBeTruthy();
  });

  it("moves focus to Cancel on open and restores it to the invoker on close", async () => {
    // Stand-in for the Settings button that opens the modal.
    const invoker = document.createElement("button");
    document.body.appendChild(invoker);
    invoker.focus();
    const onClose = vi.fn();
    try {
      const { rerender } = renderOpen(onClose);
      await screen.findByText("Metadata cache");
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Cancel" }),
      );

      rerender(<CacheManagerModal open={false} onClose={onClose} />);
      expect(document.activeElement).toBe(invoker);
    } finally {
      invoker.remove();
    }
  });
});

// ─── Optional mpv.exe fallback engine row ───────────────────────────────────
// The engine is NOT a cache category: it has its own remove command and is
// absent on most machines, so the row must appear only when installed and must
// never be checked by default.
describe("CacheManagerModal — mpv.exe fallback engine row", () => {
  const ENGINE_BYTES = 121_946_112; // ~116.3 MB

  // Sibling describe: the top-level beforeEach does not apply here.
  beforeEach(() => {
    vi.mocked(getCacheSizes).mockReset();
    vi.mocked(clearAppCache).mockReset();
    vi.mocked(getFallbackEngineSize).mockReset();
    vi.mocked(removeFallbackEngine).mockReset();
    vi.mocked(getCacheSizes).mockResolvedValue(SIZES);
    vi.mocked(getFallbackEngineSize).mockResolvedValue(null);
    vi.mocked(clearAppCache).mockResolvedValue(undefined);
    vi.mocked(removeFallbackEngine).mockResolvedValue(undefined);
    showErrorToast.mockReset();
    showSuccessToast.mockReset();
    captureError.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  function uncheckAllCategories(): void {
    for (const cb of screen.getAllByRole("checkbox")) {
      if ((cb as HTMLInputElement).checked) fireEvent.click(cb);
    }
  }

  // (1)
  it("does NOT render the fallback row when the fallback is not installed", async () => {
    vi.mocked(getFallbackEngineSize).mockResolvedValue(null);
    renderOpen();
    await screen.findByText("Metadata cache");

    expect(screen.queryByText("mpv.exe fallback engine")).toBeNull();
    expect(screen.queryByTestId("fallback-engine-checkbox")).toBeNull();
    expect(screen.getAllByRole("checkbox")).toHaveLength(4);
  });

  // (2)
  it("renders the fallback row when installed, unchecked, while the four cache rows stay checked", async () => {
    vi.mocked(getFallbackEngineSize).mockResolvedValue(ENGINE_BYTES);
    renderOpen();

    expect(await screen.findByText("mpv.exe fallback engine")).toBeTruthy();
    const engineCheckbox = screen.getByTestId<HTMLInputElement>(
      "fallback-engine-checkbox",
    );
    expect(engineCheckbox.checked).toBe(false);

    const cacheCheckboxes = screen
      .getAllByRole("checkbox")
      .filter((cb) => cb !== engineCheckbox) as HTMLInputElement[];
    expect(cacheCheckboxes).toHaveLength(4);
    expect(cacheCheckboxes.every((cb) => cb.checked)).toBe(true);

    // Same size column as the cache rows, formatted by formatBytes.
    expect(screen.getByText("116.3 MB")).toBeTruthy();

    // BUG 1: the size must not wrap. 116.3 MB does not fit a w-14 (56px)
    // column, so the column is w-20 and the value is explicitly nowrap and
    // right-aligned. A regression here renders "116.3" / "MB" on two lines.
    const sizeText = screen.getByText("116.3 MB");
    expect(sizeText.className).toContain("whitespace-nowrap");
    expect(sizeText.className).toContain("w-20");
    expect(sizeText.className).toContain("text-right");
    // Every cache row's size cell uses the same column width.
    const cacheSizeCells = screen.getAllByText("1 KB");
    expect(cacheSizeCells[0]?.className).toContain("whitespace-nowrap");
    expect(cacheSizeCells[0]?.className).toContain("w-20");
  });

  // (3)
  it("confirming with only the fallback checked removes the engine and clears no category", async () => {
    vi.mocked(getFallbackEngineSize).mockResolvedValue(ENGINE_BYTES);
    renderOpen();
    await screen.findByText("mpv.exe fallback engine");

    uncheckAllCategories();
    fireEvent.click(screen.getByTestId("fallback-engine-checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Clear Data" }));

    await waitFor(() => {
      expect(removeFallbackEngine).toHaveBeenCalledTimes(1);
    });
    expect(clearAppCache).not.toHaveBeenCalled();
    expect(showSuccessToast).toHaveBeenCalledWith("App data cleared");
  });

  // (4)
  it("confirming with cache rows checked and the fallback unchecked does NOT remove the engine", async () => {
    vi.mocked(getFallbackEngineSize).mockResolvedValue(ENGINE_BYTES);
    renderOpen();
    await screen.findByText("mpv.exe fallback engine");

    fireEvent.click(screen.getByRole("button", { name: "Clear Data" }));

    await waitFor(() => {
      expect(clearAppCache).toHaveBeenCalledWith([
        "metadata",
        "files",
        "covers",
        "prefetch",
      ]);
    });
    expect(removeFallbackEngine).not.toHaveBeenCalled();
  });

  // (5)
  it("runs both the cache clears and the removal when both are checked", async () => {
    vi.mocked(getFallbackEngineSize).mockResolvedValue(ENGINE_BYTES);
    renderOpen();
    await screen.findByText("mpv.exe fallback engine");

    fireEvent.click(screen.getByTestId("fallback-engine-checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Clear Data" }));

    await waitFor(() => {
      expect(clearAppCache).toHaveBeenCalledTimes(1);
      expect(removeFallbackEngine).toHaveBeenCalledTimes(1);
    });
    expect(showSuccessToast).toHaveBeenCalledWith("App data cleared");
    expect(showErrorToast).not.toHaveBeenCalled();
  });

  // (6)
  it("surfaces the aggregate error when removal fails, and the cache clears still ran", async () => {
    vi.mocked(getFallbackEngineSize).mockResolvedValue(ENGINE_BYTES);
    vi.mocked(removeFallbackEngine).mockRejectedValue(
      new Error("could not remove the fallback engine: permission denied"),
    );
    const onClose = vi.fn();
    renderOpen(onClose);
    await screen.findByText("mpv.exe fallback engine");

    fireEvent.click(screen.getByTestId("fallback-engine-checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Clear Data" }));

    await waitFor(() => {
      expect(showErrorToast).toHaveBeenCalledWith(
        "Couldn't clear app data. Try again.",
      );
    });
    // Order independence: both groups were attempted despite the failure.
    expect(clearAppCache).toHaveBeenCalledTimes(1);
    expect(removeFallbackEngine).toHaveBeenCalledTimes(1);
    expect(showSuccessToast).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Clear App Data")).toBeTruthy();
  });

  // (6b) The mirror case: a cache failure must not skip the removal.
  it("still removes the engine when a cache category fails", async () => {
    vi.mocked(getFallbackEngineSize).mockResolvedValue(ENGINE_BYTES);
    vi.mocked(clearAppCache).mockRejectedValue(new Error("ipc down"));
    renderOpen();
    await screen.findByText("mpv.exe fallback engine");

    fireEvent.click(screen.getByTestId("fallback-engine-checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Clear Data" }));

    await waitFor(() => {
      expect(showErrorToast).toHaveBeenCalledWith(
        "Couldn't clear app data. Try again.",
      );
    });
    expect(removeFallbackEngine).toHaveBeenCalledTimes(1);
    expect(showSuccessToast).not.toHaveBeenCalled();
  });

  // (7) Title/confirm copy, localized from the en resources.
  it("renders the renamed dialog title and confirm button", async () => {
    renderOpen();
    await screen.findByText("Metadata cache");

    expect(screen.getByRole("dialog", { name: "Clear App Data" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Clear App Data" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear Data" })).toBeTruthy();
  });

  // An installed engine alone keeps the confirm enabled (the four rows can all
  // be unchecked); nothing checked at all keeps it disabled.
  it("keeps Clear enabled when only the fallback row is checked", async () => {
    vi.mocked(getFallbackEngineSize).mockResolvedValue(ENGINE_BYTES);
    renderOpen();
    await screen.findByText("mpv.exe fallback engine");

    uncheckAllCategories();
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Clear Data" })
        .disabled,
    ).toBe(true);

    fireEvent.click(screen.getByTestId("fallback-engine-checkbox"));
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Clear Data" })
        .disabled,
    ).toBe(false);
  });
});
