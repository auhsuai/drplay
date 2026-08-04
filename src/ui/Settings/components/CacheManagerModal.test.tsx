// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { CacheManagerModal } from "./CacheManagerModal";
import {
  getCacheSizes,
  clearAppCache,
  type CacheCategoryId,
  type CacheCategoryInfo,
} from "../../../utils/cache";

// react-i18next has no initialized instance in the node test env, so stub
// useTranslation to return the defaultValue passed to t() (same as
// SettingsTab.test.tsx).
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, defaultValue?: string) => defaultValue ?? _key,
  }),
}));

vi.mock("lucide-react", () => {
  // Spread props so data-testid from LoaderCircle survives in the DOM.
  const Stub = (props: Record<string, unknown>) => <div {...props} />;
  return { X: Stub, LoaderCircle: Stub, Check: Stub };
});

vi.mock("../../../utils/cache", () => ({
  getCacheSizes: vi.fn(),
  clearAppCache: vi.fn(),
  CACHE_CATEGORY_LABELS: {
    metadata: "Metadata cache",
    files: "File listing cache",
    covers: "Covers & thumbnails",
    prefetch: "Prefetched data",
  } satisfies Record<CacheCategoryId, string>,
}));

const captureError = vi.fn();
vi.mock("../../../utils/errorLog", () => ({
  captureError: (input: unknown) => captureError(input),
}));

const showErrorToast = vi.fn();
const showSuccessToast = vi.fn();
vi.mock("../../../utils/simpleToast", () => ({
  showErrorToast: (msg: string) => showErrorToast(msg),
  showSuccessToast: (msg: string) => showSuccessToast(msg),
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
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.mocked(getCacheSizes).mockReset();
    vi.mocked(clearAppCache).mockReset();
    vi.mocked(getCacheSizes).mockResolvedValue(SIZES);
    showErrorToast.mockReset();
    showSuccessToast.mockReset();
    captureError.mockReset();
  });

  it("renders nothing when closed", () => {
    const { container } = render(<CacheManagerModal open={false} onClose={vi.fn()} />);
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
    expect(checkboxes.every((cb) => (cb as HTMLInputElement).checked)).toBe(true);
  });

  it("renders the 4 category rows immediately with per-row size spinners, then swaps in sizes", async () => {
    // Deferred promise: the modal must not gate the rows on the fetch.
    let resolveSizes!: (v: CacheCategoryInfo[]) => void;
    vi.mocked(getCacheSizes).mockReturnValue(
      new Promise((resolve) => {
        resolveSizes = resolve;
      })
    );
    renderOpen();

    // Rows render from CACHE_CATEGORY_LABELS right away, no "Loading..." row.
    expect(screen.getByText("Metadata cache")).toBeTruthy();
    expect(screen.getByText("File listing cache")).toBeTruthy();
    expect(screen.getByText("Covers & thumbnails")).toBeTruthy();
    expect(screen.getByText("Prefetched data")).toBeTruthy();
    expect(screen.queryByText("Loading...")).toBeNull();

    // Every row shows a small spinner in its size slot until the fetch resolves.
    expect(screen.getAllByTestId("size-spinner")).toHaveLength(4);
    expect(screen.queryByText("1 KB")).toBeNull();

    resolveSizes(SIZES);
    await waitFor(() => {
      expect(screen.queryAllByTestId("size-spinner")).toHaveLength(0);
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
      (screen.getByRole("button", { name: "Clear Cache" }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it("calls clearAppCache with only the still-checked categories", async () => {
    vi.mocked(clearAppCache).mockResolvedValue(undefined);
    renderOpen();
    await screen.findByText("Metadata cache");
    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[1]);
    fireEvent.click(screen.getByRole("button", { name: "Clear Cache" }));
    await waitFor(() => {
      expect(clearAppCache).toHaveBeenCalledWith(["metadata", "covers", "prefetch"]);
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
    fireEvent.click(screen.getByRole("button", { name: "Clear Cache" }));
    await waitFor(() => {
      expect(showSuccessToast).toHaveBeenCalledWith("Cache cleared successfully!");
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(showErrorToast).not.toHaveBeenCalled();
  });

  it("shows an error toast and stays open when clearing fails", async () => {
    vi.mocked(clearAppCache).mockRejectedValue(new Error("boom"));
    renderOpen();
    await screen.findByText("Metadata cache");
    fireEvent.click(screen.getByRole("button", { name: "Clear Cache" }));
    await waitFor(() => {
      expect(showErrorToast).toHaveBeenCalledWith("Failed to clear cache.");
    });
    expect(showSuccessToast).not.toHaveBeenCalled();
    expect(screen.getByText("Clear App Cache")).toBeTruthy();
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
});
