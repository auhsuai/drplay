// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Profiler, useState } from "react";
import { FolderSelectionScreen } from "./FolderSelectionScreen";
import en from "../../locales/en/translation.json";
import { DEBUG_EVENTS } from "../debug/debugEvents";

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
    "Folder",
    "ArrowLeft",
    "HardDrive",
    "Check",
    "Search",
    "LoaderCircle",
    "X",
  ];
  const Stub = () => null;
  return Object.fromEntries(icons.map((n) => [n, Stub]));
});

const mocks = vi.hoisted(() => ({
  driveApi: {
    FOLDER_MIME: "application/vnd.google-apps.folder",
    listFolderChildren: vi.fn(),
    searchFolders: vi.fn(),
    getFileParents: vi.fn(),
    getFileName: vi.fn(),
  },
  getValidToken: vi.fn(),
  showErrorToast: vi.fn(),
  captureError: vi.fn(),
}));

vi.mock("../../utils/driveApi", () => mocks.driveApi);
vi.mock("../../utils/drivePagination", () => ({
  listFolderChildren: mocks.driveApi.listFolderChildren,
  searchFolders: mocks.driveApi.searchFolders,
}));
vi.mock("../../utils/apiClient", () => ({
  getValidToken: mocks.getValidToken,
}));
vi.mock("../../utils/simpleToast", () => ({
  showErrorToast: mocks.showErrorToast,
}));
vi.mock("../../utils/errorLog", () => ({ captureError: mocks.captureError }));
vi.mock("../../db/db", () => {
  const chain = {
    equals: () => chain,
    filter: () => chain,
    toArray: () => Promise.resolve([]),
  };
  return { db: { files: { where: () => chain } } };
});

type DeferredCall = {
  resolve: (value: Array<{ id: string; name: string }>) => void;
  reject: (err: unknown) => void;
  signal: AbortSignal | undefined;
};

let deferredCalls: DeferredCall[] = [];

function installListFolderChildrenMock() {
  mocks.driveApi.listFolderChildren.mockImplementation(
    (_token: string, _folderId: string, signal?: AbortSignal) =>
      new Promise<Array<{ id: string; name: string }>>((resolve, reject) => {
        deferredCalls.push({ resolve, reject, signal });
        signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      }),
  );
}

// Deferred promise for the debounced API search, used to pin isLoading=true
// and isSearchingApi=true at the same time (search while folder fetch pending).
let searchDeferredCalls: DeferredCall[] = [];

function installSearchFoldersMock() {
  mocks.driveApi.searchFolders.mockImplementation(
    (_token: string, _query: string, signal?: AbortSignal) =>
      new Promise<Array<{ id: string; name: string }>>((resolve, reject) => {
        searchDeferredCalls.push({ resolve, reject, signal });
      }),
  );
}

const BACK_BUTTON_INDEX = 0;

function backButton(): HTMLElement {
  const btn = screen.getAllByRole("button")[BACK_BUTTON_INDEX];
  if (btn === undefined) throw new Error("expected back button");
  return btn;
}

function deferredCallAt(index: number): DeferredCall {
  const call = deferredCalls[index];
  if (call === undefined)
    throw new Error(`expected deferred folder call ${String(index)}`);
  return call;
}

function renderScreen() {
  return render(
    <FolderSelectionScreen
      token="test-token"
      onSelectFolder={vi.fn()}
      initialFolderId="folderB"
      initialFolderHistory={[{ id: "root", name: "My Drive" }]}
    />,
  );
}

describe("FolderSelectionScreen", () => {
  beforeEach(() => {
    deferredCalls = [];
    vi.clearAllMocks();
    installListFolderChildrenMock();
    mocks.driveApi.searchFolders.mockResolvedValue([]);
    mocks.driveApi.getFileParents.mockResolvedValue(null);
    mocks.driveApi.getFileName.mockResolvedValue(null);
    mocks.getValidToken.mockResolvedValue("test-token");
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps the latest folder listing when an older slower fetch resolves after navigation (race)", async () => {
    renderScreen();
    await waitFor(() => {
      expect(deferredCalls).toHaveLength(1);
    });

    fireEvent.click(backButton());
    await waitFor(() => {
      expect(deferredCalls).toHaveLength(2);
    });

    const newFolderFetch = deferredCallAt(1);
    await act(async () => {
      newFolderFetch.resolve([{ id: "f1", name: "Folder 1" }]);
      await Promise.resolve();
    });
    expect(screen.queryByText("Folder 1")).not.toBeNull();

    const staleFolderFetch = deferredCallAt(0);
    expect(staleFolderFetch.signal?.aborted).toBe(true);
    await act(async () => {
      staleFolderFetch.resolve([{ id: "stale", name: "STALE" }]);
      await Promise.resolve();
    });
    expect(screen.queryByText("STALE")).toBeNull();
    expect(screen.queryByText("Folder 1")).not.toBeNull();
  });

  it("aborts the in-flight fetch on unmount and never updates state afterward", async () => {
    const { unmount } = renderScreen();
    await waitFor(() => {
      expect(deferredCalls).toHaveLength(1);
    });

    unmount();

    const inFlight = deferredCallAt(0);
    expect(inFlight.signal?.aborted).toBe(true);

    await act(async () => {
      inFlight.resolve([{ id: "late", name: "LATE" }]);
      await Promise.resolve();
    });

    expect(mocks.showErrorToast).not.toHaveBeenCalled();
    expect(mocks.captureError).not.toHaveBeenCalled();
  });

  it("does not toast when the in-flight folder fetch is aborted by navigation", async () => {
    renderScreen();
    await waitFor(() => {
      expect(deferredCalls).toHaveLength(1);
    });

    fireEvent.click(backButton());
    await waitFor(() => {
      expect(deferredCalls).toHaveLength(2);
    });

    await act(async () => {
      deferredCallAt(0).reject(
        new DOMException("The operation was aborted", "AbortError"),
      );
      deferredCallAt(1).resolve([{ id: "f1", name: "Folder 1" }]);
      await Promise.resolve();
    });

    expect(mocks.showErrorToast).not.toHaveBeenCalled();
    expect(mocks.captureError).not.toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining(
          "failed-to-fetch-folders",
        ) as unknown as string,
      }),
    );
    expect(screen.queryByText("Folder 1")).not.toBeNull();
  });

  it("guards the localStorage root-folder read: SecurityError → warn + fallback null (no crash)", async () => {
    const getItemSpy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new DOMException("storage blocked", "SecurityError");
      });
    try {
      render(
        <FolderSelectionScreen
          token="test-token"
          onSelectFolder={vi.fn()}
          initialFolderId="folderB"
          initialFolderHistory={[{ id: "root", name: "My Drive" }]}
        />,
      );
      // Component still mounts and starts the normal folder fetch.
      await waitFor(() => {
        expect(deferredCalls).toHaveLength(1);
      });
      expect(mocks.captureError).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "warn",
          source: "FolderSelectionScreen",
          message: expect.stringContaining(
            "root-folder-read-failed",
          ) as unknown as string,
        }),
      );
    } finally {
      getItemSpy.mockRestore();
    }
  });
});

describe("FolderSelectionScreen skeleton loading", () => {
  beforeEach(() => {
    deferredCalls = [];
    searchDeferredCalls = [];
    vi.clearAllMocks();
    installListFolderChildrenMock();
    installSearchFoldersMock();
    mocks.driveApi.getFileParents.mockResolvedValue(null);
    mocks.driveApi.getFileName.mockResolvedValue(null);
    mocks.getValidToken.mockResolvedValue("test-token");
  });

  afterEach(() => {
    cleanup();
  });

  it("shows 6 skeleton rows inside a status region instead of the spinner while loading folders", async () => {
    renderScreen();
    await waitFor(() => {
      expect(deferredCalls).toHaveLength(1);
    });

    const rows = await screen.findAllByTestId("skeleton-row");
    expect(rows).toHaveLength(6);
    expect(screen.getByRole("status", { name: "Loading..." })).toBeTruthy();
    expect(document.querySelector(".animate-spin")).toBeNull();
  });

  it('keeps the "Searching deeper..." branch while an API search is in flight (no skeleton)', async () => {
    renderScreen();
    await waitFor(() => {
      expect(deferredCalls).toHaveLength(1);
    });

    fireEvent.change(screen.getByPlaceholderText("Search..."), {
      target: { value: "abc" },
    });
    await waitFor(() => {
      expect(searchDeferredCalls).toHaveLength(1);
    });

    expect(screen.getByText("Searching deeper...")).not.toBeNull();
    expect(screen.queryAllByTestId("skeleton-row")).toHaveLength(0);
    expect(document.querySelector(".animate-spin")).toBeNull();
  });

  it("renders the real folder list once loading finishes", async () => {
    renderScreen();
    await waitFor(() => {
      expect(deferredCalls).toHaveLength(1);
    });

    await act(async () => {
      deferredCallAt(0).resolve([{ id: "f1", name: "Folder 1" }]);
      await Promise.resolve();
    });

    expect(await screen.findByText("Folder 1")).not.toBeNull();
    expect(screen.queryAllByTestId("skeleton-row")).toHaveLength(0);
  });

  it("keeps the empty state when no folders are returned", async () => {
    renderScreen();
    await waitFor(() => {
      expect(deferredCalls).toHaveLength(1);
    });

    await act(async () => {
      deferredCallAt(0).resolve([]);
      await Promise.resolve();
    });

    expect(await screen.findByText("No folders here.")).not.toBeNull();
    expect(screen.queryAllByTestId("skeleton-row")).toHaveLength(0);
  });

  it('never flashes the "no folders" empty state before the skeleton (first commit is already loading)', async () => {
    // The flash lives in the FIRST commit (isLoading starts false) which
    // act() flushes away before returning. Profiler.onRender fires
    // synchronously after EVERY commit — reading the DOM there captures each
    // committed frame in order, including frame 1.
    const markers: string[] = [];
    const recordMarkers = () => {
      const hasSkeleton =
        document.querySelector('[data-testid="skeleton-row"]') !== null;
      const hasEmpty = (document.body.textContent ?? "").includes(
        "No folders here.",
      );
      if (hasSkeleton && !markers.includes("skeleton"))
        markers.push("skeleton");
      if (hasEmpty && !markers.includes("empty")) markers.push("empty");
    };

    const { unmount } = render(
      <Profiler id="folder-frame-probe" onRender={recordMarkers}>
        <FolderSelectionScreen
          token="test-token"
          onSelectFolder={vi.fn()}
          initialFolderId="folderB"
          initialFolderHistory={[{ id: "root", name: "My Drive" }]}
        />
      </Profiler>,
    );
    await act(async () => {});
    unmount();

    expect(markers).toContain("skeleton");
    expect(markers).not.toContain("empty");
  });

  it("grid: the loading skeleton mirrors the real folder grid (3-col, natural row height)", async () => {
    renderScreen();
    await waitFor(() => {
      expect(deferredCalls).toHaveLength(1);
    });

    const status = screen.getByRole("status", { name: "Loading..." });
    // The folder list is a definite-height flex child (overlay root is
    // fixed inset-0, dialog h-[75vh]) so h-full resolves here.
    expect(status.className).toContain("h-full");
    const rows = screen.getAllByTestId("skeleton-row");
    expect(rows).toHaveLength(6);
    // The skeleton container mirrors the real list container
    // (FolderGrid.tsx:66 and FolderGrid.tsx:100 — grid grid-cols-1
    // sm:grid-cols-2 lg:grid-cols-3 gap-3) so the shape does not jump when
    // data loads. No h-full/auto-rows-fr: those stretched every row to split
    // the list height, making each skeleton ~3x taller than a FolderCard.
    const row = rows[0];
    if (row === undefined) throw new Error("expected skeleton row");
    const container = row.parentElement;
    expect(container).not.toBeNull();
    if (container) {
      expect(container.className).toContain(
        "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3",
      );
      expect(container.className).not.toContain("auto-rows-fr");
      expect(container.className).not.toContain("h-full");
    }
  });

  it('never shows the empty "no folders" state while loading with a search query typed (API-search branch wins)', async () => {
    renderScreen();
    await waitFor(() => {
      expect(deferredCalls).toHaveLength(1);
    });

    // While the folder fetch is still pending, typing a query must not swap
    // into the empty state: the loading/API-search branches take precedence
    // over every empty-state branch (drive.no_folders).
    fireEvent.change(screen.getByPlaceholderText("Search..."), {
      target: { value: "abc" },
    });
    await waitFor(() => {
      expect(searchDeferredCalls).toHaveLength(1);
    });

    expect(screen.queryByText("No folders here.")).toBeNull();
    expect(screen.queryAllByTestId("skeleton-row").length).toBe(0);
    expect(screen.getByText("Searching deeper...")).not.toBeNull();
  });
});

describe("FolderSelectionScreen API search gating", () => {
  beforeEach(() => {
    deferredCalls = [];
    searchDeferredCalls = [];
    vi.clearAllMocks();
    installListFolderChildrenMock();
    installSearchFoldersMock();
    mocks.driveApi.getFileParents.mockResolvedValue(null);
    mocks.driveApi.getFileName.mockResolvedValue(null);
    mocks.getValidToken.mockResolvedValue("test-token");
  });

  afterEach(() => {
    cleanup();
  });

  it("fires the deeper Drive search even when local folders match (gating regression) and renders both sections", async () => {
    renderScreen();
    await waitFor(() => {
      expect(deferredCalls).toHaveLength(1);
    });
    await act(async () => {
      deferredCallAt(0).resolve([{ id: "local", name: "ABC Local" }]);
      await Promise.resolve();
    });
    expect(screen.getByText("ABC Local")).not.toBeNull();

    fireEvent.change(screen.getByPlaceholderText("Search..."), {
      target: { value: "abc" },
    });
    // Regression: the old effect gate (filteredFolders.length > 0) skipped
    // the API search whenever a local folder matched, so folders outside the
    // current directory were unreachable.
    await waitFor(() => {
      expect(searchDeferredCalls).toHaveLength(1);
    });

    expect(screen.getByText("ABC Local")).not.toBeNull();
    expect(screen.getByText("From subfolders")).not.toBeNull();
    expect(screen.getByText("Searching deeper...")).not.toBeNull();

    const apiCall = searchDeferredCalls[0];
    if (apiCall === undefined)
      throw new Error("expected deferred api search call");
    await act(async () => {
      apiCall.resolve([{ id: "deep", name: "Deep Folder" }]);
      await Promise.resolve();
    });

    expect(screen.getByText("ABC Local")).not.toBeNull();
    expect(screen.getByText("Deep Folder")).not.toBeNull();
    expect(screen.queryByText("Searching deeper...")).toBeNull();
  });

  it("drops an API search hit whose id already renders in the local listing (no duplicate card)", async () => {
    renderScreen();
    await waitFor(() => {
      expect(deferredCalls).toHaveLength(1);
    });
    await act(async () => {
      deferredCallAt(0).resolve([
        { id: "dup", name: "ABC Local" },
        { id: "other", name: "Other" },
      ]);
      await Promise.resolve();
    });

    fireEvent.change(screen.getByPlaceholderText("Search..."), {
      target: { value: "abc" },
    });
    await waitFor(() => {
      expect(searchDeferredCalls).toHaveLength(1);
    });

    const apiCall = searchDeferredCalls[0];
    if (apiCall === undefined)
      throw new Error("expected deferred api search call");
    await act(async () => {
      // The deeper Drive search can repeat a direct child that already
      // matched locally (same id) alongside genuinely deeper folders.
      apiCall.resolve([
        { id: "dup", name: "ABC Local" },
        { id: "deep", name: "Deep ABC" },
      ]);
      await Promise.resolve();
    });

    // The overlapping id renders exactly ONCE — the local section keeps it,
    // only the API section drops it — and section order is untouched.
    expect(screen.getAllByText("ABC Local")).toHaveLength(1);
    expect(screen.getByText("Deep ABC")).not.toBeNull();
    const text = document.body.textContent ?? "";
    expect(text.indexOf("ABC Local")).toBeLessThan(
      text.indexOf("From subfolders"),
    );
    expect(text.indexOf("From subfolders")).toBeLessThan(
      text.indexOf("Deep ABC"),
    );
  });

  it("passes the refreshed getValidToken token to the deeper search (token symmetry with fetchFolders)", async () => {
    mocks.getValidToken.mockResolvedValue("fresh-token");
    renderScreen();
    await waitFor(() => {
      expect(deferredCalls).toHaveLength(1);
    });
    await act(async () => {
      deferredCallAt(0).resolve([]);
      await Promise.resolve();
    });

    fireEvent.change(screen.getByPlaceholderText("Search..."), {
      target: { value: "abc" },
    });
    await waitFor(() => {
      expect(searchDeferredCalls).toHaveLength(1);
    });

    expect(mocks.driveApi.searchFolders).toHaveBeenCalledWith(
      "fresh-token",
      expect.stringContaining("name contains 'abc'"),
      expect.anything(),
    );
  });

  it("matches local folders diacritics-insensitively ('doi' finds 'Đổi mới')", async () => {
    renderScreen();
    await waitFor(() => {
      expect(deferredCalls).toHaveLength(1);
    });
    await act(async () => {
      deferredCallAt(0).resolve([{ id: "doi-moi", name: "Đổi mới" }]);
      await Promise.resolve();
    });

    fireEvent.change(screen.getByPlaceholderText("Search..."), {
      target: { value: "doi" },
    });

    expect(screen.getByText("Đổi mới")).not.toBeNull();
  });

  it("never calls the Drive API search for a 1-character query (min-length 2)", async () => {
    renderScreen();
    await waitFor(() => {
      expect(deferredCalls).toHaveLength(1);
    });
    await act(async () => {
      deferredCallAt(0).resolve([]);
      await Promise.resolve();
    });

    fireEvent.change(screen.getByPlaceholderText("Search..."), {
      target: { value: "a" },
    });
    // Longer than SEARCH_DEBOUNCE_MS (300) so the debounced callback ran.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });

    expect(mocks.driveApi.searchFolders).not.toHaveBeenCalled();
    expect(screen.getByText("No matching folders found.")).not.toBeNull();
    expect(screen.queryByText("No folders here.")).toBeNull();
  });
});

describe("FolderSelectionScreen debug empty trigger", () => {
  beforeEach(() => {
    deferredCalls = [];
    vi.clearAllMocks();
    installListFolderChildrenMock();
    mocks.driveApi.searchFolders.mockResolvedValue([]);
    mocks.driveApi.getFileParents.mockResolvedValue(null);
    mocks.driveApi.getFileName.mockResolvedValue(null);
    mocks.getValidToken.mockResolvedValue("test-token");
  });

  afterEach(() => {
    cleanup();
  });

  function dispatchFoldersEmpty() {
    act(() => {
      window.dispatchEvent(new CustomEvent(DEBUG_EVENTS.FOLDERS_EMPTY));
    });
  }

  it("dispatches FOLDERS_EMPTY while the folder fetch is still pending -> no-folders empty state, no skeleton", async () => {
    renderScreen();
    await waitFor(() => {
      expect(deferredCalls).toHaveLength(1);
    });
    expect(screen.queryAllByTestId("skeleton-row")).not.toHaveLength(0);

    dispatchFoldersEmpty();

    expect(screen.getByText("No folders here.")).not.toBeNull();
    expect(screen.queryAllByTestId("skeleton-row")).toHaveLength(0);
    expect(screen.queryByRole("status", { name: "Loading..." })).toBeNull();
  });

  it("dispatches FOLDERS_EMPTY after folders loaded -> grid replaced by the empty state", async () => {
    renderScreen();
    await waitFor(() => {
      expect(deferredCalls).toHaveLength(1);
    });
    await act(async () => {
      deferredCallAt(0).resolve([{ id: "f1", name: "Folder 1" }]);
      await Promise.resolve();
    });
    await screen.findByText("Folder 1");

    dispatchFoldersEmpty();

    expect(screen.getByText("No folders here.")).not.toBeNull();
    expect(screen.queryByText("Folder 1")).toBeNull();
    expect(screen.queryAllByTestId("skeleton-row")).toHaveLength(0);
  });

  it("unmount -> dispatching FOLDERS_EMPTY is a no-op (listener cleaned up)", async () => {
    const { unmount } = renderScreen();
    await waitFor(() => {
      expect(deferredCalls).toHaveLength(1);
    });

    unmount();
    expect(() => {
      dispatchFoldersEmpty();
    }).not.toThrow();
  });
});

describe("FolderSelectionScreen debug skeleton trigger", () => {
  beforeEach(() => {
    deferredCalls = [];
    vi.clearAllMocks();
    installListFolderChildrenMock();
    mocks.driveApi.searchFolders.mockResolvedValue([]);
    mocks.driveApi.getFileParents.mockResolvedValue(null);
    mocks.driveApi.getFileName.mockResolvedValue(null);
    mocks.getValidToken.mockResolvedValue("test-token");
  });

  afterEach(() => {
    cleanup();
  });

  function dispatchSkeleton(target: unknown = "folders") {
    act(() => {
      window.dispatchEvent(
        new CustomEvent(DEBUG_EVENTS.SKELETON, { detail: { target } }),
      );
    });
  }

  it("SKELETON target folders after folders loaded -> grid replaced by the skeleton", async () => {
    renderScreen();
    await waitFor(() => {
      expect(deferredCalls).toHaveLength(1);
    });
    await act(async () => {
      deferredCallAt(0).resolve([{ id: "f1", name: "Folder 1" }]);
      await Promise.resolve();
    });
    await screen.findByText("Folder 1");
    expect(screen.queryAllByTestId("skeleton-row")).toHaveLength(0);

    dispatchSkeleton();

    expect(screen.queryByText("Folder 1")).toBeNull();
    expect(screen.queryAllByTestId("skeleton-row")).not.toHaveLength(0);
    expect(screen.getByRole("status", { name: "Loading..." })).not.toBeNull();
  });

  it("SKELETON with a non-folders target leaves the loaded grid untouched", async () => {
    renderScreen();
    await waitFor(() => {
      expect(deferredCalls).toHaveLength(1);
    });
    await act(async () => {
      deferredCallAt(0).resolve([{ id: "f1", name: "Folder 1" }]);
      await Promise.resolve();
    });
    await screen.findByText("Folder 1");

    dispatchSkeleton("home");

    expect(screen.getByText("Folder 1")).not.toBeNull();
    expect(screen.queryAllByTestId("skeleton-row")).toHaveLength(0);
  });

  it("unmount -> dispatching SKELETON is a no-op (listener cleaned up)", async () => {
    const { unmount } = renderScreen();
    await waitFor(() => {
      expect(deferredCalls).toHaveLength(1);
    });

    unmount();
    expect(() => {
      dispatchSkeleton();
    }).not.toThrow();
  });
});

describe("FolderSelectionScreen Escape close (QP-3 / Esc-close 2026-09-14)", () => {
  beforeEach(() => {
    deferredCalls = [];
    vi.clearAllMocks();
    installListFolderChildrenMock();
    mocks.driveApi.searchFolders.mockResolvedValue([]);
    mocks.driveApi.getFileParents.mockResolvedValue(null);
    mocks.driveApi.getFileName.mockResolvedValue(null);
    mocks.getValidToken.mockResolvedValue("test-token");
  });

  afterEach(() => {
    cleanup();
  });

  // Unmounts the picker on cancel, so close-side effects (focus return) are
  // observable instead of being overwritten by the still-mounted screen.
  function PickerHost({ onCancel }: { onCancel: () => void }) {
    const [open, setOpen] = useState(true);
    if (!open) return null;
    return (
      <FolderSelectionScreen
        token="test-token"
        onSelectFolder={vi.fn()}
        onCancel={() => {
          setOpen(false);
          onCancel();
        }}
        initialFolderId="folderB"
        initialFolderHistory={[{ id: "root", name: "My Drive" }]}
      />
    );
  }

  it("Esc trong search có text → clear + blur, picker vẫn mở (staged, parity QSI-1)", async () => {
    const onCancel = vi.fn();
    render(<PickerHost onCancel={onCancel} />);
    await waitFor(() => {
      expect(deferredCalls).toHaveLength(1);
    });

    const input = screen.getByPlaceholderText("Search...");
    fireEvent.change(input, { target: { value: "abc" } });
    input.focus();
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(input, { key: "Escape" });

    expect((input as HTMLInputElement).value).toBe("");
    expect(document.activeElement).not.toBe(input);
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText("Search...")).not.toBeNull();
  });

  it("Esc khi search trống → đóng picker (onCancel 1 lần)", async () => {
    const onCancel = vi.fn();
    render(<PickerHost onCancel={onCancel} />);
    await waitFor(() => {
      expect(deferredCalls).toHaveLength(1);
    });

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByPlaceholderText("Search...")).toBeNull();
  });

  it("Esc đóng picker → focus trả về element đã focus lúc mount (APG focus-return)", async () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const onCancel = vi.fn();
    render(<PickerHost onCancel={onCancel} />);
    await waitFor(() => {
      expect(deferredCalls).toHaveLength(1);
    });

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});

const DIALOG_FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

describe("FolderSelectionScreen APG dialog semantics (P2-10-1)", () => {
  beforeEach(() => {
    deferredCalls = [];
    vi.clearAllMocks();
    installListFolderChildrenMock();
    mocks.driveApi.searchFolders.mockResolvedValue([]);
    mocks.driveApi.getFileParents.mockResolvedValue(null);
    mocks.driveApi.getFileName.mockResolvedValue(null);
    mocks.getValidToken.mockResolvedValue("test-token");
  });

  afterEach(() => {
    cleanup();
  });

  it('exposes role="dialog" aria-modal="true" aria-labelledby pointing to the visible title', () => {
    renderScreen();
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe(
      "folder-selection-title",
    );
    const title = document.getElementById("folder-selection-title");
    expect(title).not.toBeNull();
    if (title) expect(dialog.contains(title)).toBe(true);
  });

  it("moves focus into the dialog on mount and restores the invoker on unmount", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    // try/finally: a failing assertion must not leak the detached trigger
    // into the shared jsdom body (it would shadow the picker's back button
    // for later tests querying getAllByRole("button")).
    try {
      trigger.focus();
      expect(document.activeElement).toBe(trigger);

      const { unmount } = renderScreen();

      expect(document.activeElement).toBe(screen.getByRole("dialog"));

      unmount();
      expect(document.activeElement).toBe(trigger);
    } finally {
      trigger.remove();
    }
  });

  it("traps Tab: from the dialog container focus wraps to the first focusable control", () => {
    renderScreen();
    const dialog = screen.getByRole("dialog");
    expect(document.activeElement).toBe(dialog);

    fireEvent.keyDown(dialog, { key: "Tab" });

    const focusables = dialog.querySelectorAll<HTMLElement>(
      DIALOG_FOCUSABLE_SELECTOR,
    );
    expect(document.activeElement).toBe(focusables[0]);
  });

  it("traps Tab: from the last focusable control focus wraps back to the first", () => {
    renderScreen();
    const dialog = screen.getByRole("dialog");
    const focusables = dialog.querySelectorAll<HTMLElement>(
      DIALOG_FOCUSABLE_SELECTOR,
    );
    const last = focusables[focusables.length - 1];
    if (!last) throw new Error("expected at least one focusable control");
    last.focus();

    fireEvent.keyDown(last, { key: "Tab" });

    expect(document.activeElement).toBe(focusables[0]);
  });

  it("traps Shift+Tab: from the first focusable control focus wraps to the last", () => {
    renderScreen();
    const dialog = screen.getByRole("dialog");
    const focusables = dialog.querySelectorAll<HTMLElement>(
      DIALOG_FOCUSABLE_SELECTOR,
    );
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!first || !last) throw new Error("expected focusable controls");
    first.focus();

    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });

    expect(document.activeElement).toBe(last);
  });
});

describe("FolderSelectionScreen search spinner race (P2-10-3)", () => {
  beforeEach(() => {
    deferredCalls = [];
    searchDeferredCalls = [];
    vi.clearAllMocks();
    installListFolderChildrenMock();
    installSearchFoldersMock();
    mocks.driveApi.getFileParents.mockResolvedValue(null);
    mocks.driveApi.getFileName.mockResolvedValue(null);
    mocks.getValidToken.mockResolvedValue("test-token");
  });

  afterEach(() => {
    cleanup();
  });

  it("an aborted search resolving during the token wait must not clear the newer search's spinner", async () => {
    renderScreen();
    await waitFor(() => {
      expect(deferredCalls).toHaveLength(1);
    });
    await act(async () => {
      deferredCallAt(0).resolve([]);
      await Promise.resolve();
    });

    // Park every subsequent search at `await getValidToken()` — the token
    // refresh window where the abort of the older search has no effect yet.
    let resolveToken: (value: string) => void = () => {
      throw new Error("token deferred not armed");
    };
    const tokenPromise = new Promise<string>((resolve) => {
      resolveToken = resolve;
    });
    mocks.getValidToken.mockReturnValue(tokenPromise);

    // Search A ("ab") starts and waits for the token.
    fireEvent.change(screen.getByPlaceholderText("Search..."), {
      target: { value: "ab" },
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(screen.getByText("Searching deeper...")).not.toBeNull();

    // Query change aborts A while it still waits for the token; search B
    // ("abc") starts and waits for the SAME token promise.
    fireEvent.change(screen.getByPlaceholderText("Search..."), {
      target: { value: "abc" },
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(screen.getByText("Searching deeper...")).not.toBeNull();

    // Token refresh resolves: the stale search must bail out on its aborted
    // signal instead of running to its finally and clearing the spinner.
    await act(async () => {
      resolveToken("fresh-token");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Simulate the network abort landing for any stale (already-aborted) call.
    await act(async () => {
      for (const call of searchDeferredCalls) {
        if (call.signal?.aborted) {
          call.reject(
            new DOMException("The operation was aborted", "AbortError"),
          );
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // B is still in flight: the spinner must stay on, the stale search must
    // not have fired a Drive request and the abort path must not toast.
    expect(screen.getByText("Searching deeper...")).not.toBeNull();
    expect(mocks.driveApi.searchFolders).toHaveBeenCalledTimes(1);
    expect(mocks.driveApi.searchFolders.mock.calls[0]?.[1]).toContain(
      "name contains 'abc'",
    );
    expect(mocks.showErrorToast).not.toHaveBeenCalled();
  });
});

describe("FolderSelectionScreen parent-walk guard (P2-10-4)", () => {
  beforeEach(() => {
    deferredCalls = [];
    vi.clearAllMocks();
    installListFolderChildrenMock();
    mocks.driveApi.searchFolders.mockResolvedValue([]);
    mocks.driveApi.getFileName.mockResolvedValue(null);
    mocks.getValidToken.mockResolvedValue("test-token");
  });

  afterEach(() => {
    cleanup();
  });

  it("an unusable parent id does not strand the picker in loading (Back + open still work)", async () => {
    mocks.driveApi.getFileParents.mockResolvedValue([undefined]);

    render(
      <FolderSelectionScreen
        token="test-token"
        onSelectFolder={vi.fn()}
        initialFolderId="folderB"
        initialFolderHistory={[]}
        appRootFolder="other-root"
      />,
    );
    await waitFor(() => {
      expect(deferredCalls).toHaveLength(1);
    });
    await act(async () => {
      deferredCallAt(0).resolve([{ id: "f1", name: "Folder 1" }]);
      await Promise.resolve();
    });
    await screen.findByText("Folder 1");

    // Empty history → Back walks to the Drive parent (the patched branch).
    fireEvent.click(backButton());
    await waitFor(() => {
      expect(mocks.driveApi.getFileParents).toHaveBeenCalled();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.queryAllByTestId("skeleton-row")).toHaveLength(0);
    expect(screen.getByText("Folder 1")).not.toBeNull();

    // The picker is not frozen: opening a folder still starts a fetch.
    fireEvent.click(screen.getByRole("button", { name: /Folder 1/ }));
    await waitFor(() => {
      expect(deferredCalls).toHaveLength(2);
    });
  });
});

describe("FolderSelectionScreen search clear button (P2-10-8)", () => {
  beforeEach(() => {
    deferredCalls = [];
    vi.clearAllMocks();
    installListFolderChildrenMock();
    mocks.driveApi.searchFolders.mockResolvedValue([]);
    mocks.driveApi.getFileParents.mockResolvedValue(null);
    mocks.driveApi.getFileName.mockResolvedValue(null);
    mocks.getValidToken.mockResolvedValue("test-token");
  });

  afterEach(() => {
    cleanup();
  });

  it("renders an accessible clear button while a query is typed; clicking it empties the input", async () => {
    renderScreen();
    await waitFor(() => {
      expect(deferredCalls).toHaveLength(1);
    });
    await act(async () => {
      deferredCallAt(0).resolve([]);
      await Promise.resolve();
    });

    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();

    const input = screen.getByPlaceholderText("Search...");
    fireEvent.change(input, { target: { value: "abc" } });

    const clear = screen.getByRole("button", { name: "Clear search" });
    fireEvent.click(clear);

    expect((input as HTMLInputElement).value).toBe("");
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
  });
});

type NavFrame = { skeleton: boolean; staleFolderCard: boolean };

describe("FolderSelectionScreen navigation loading transition (P2-10-5)", () => {
  beforeEach(() => {
    deferredCalls = [];
    vi.clearAllMocks();
    installListFolderChildrenMock();
    mocks.driveApi.searchFolders.mockResolvedValue([]);
    mocks.driveApi.getFileParents.mockResolvedValue(null);
    mocks.driveApi.getFileName.mockResolvedValue(null);
    mocks.getValidToken.mockResolvedValue("test-token");
  });

  afterEach(() => {
    cleanup();
  });

  // Same Profiler probe as the RC-B flash test above: onRender fires
  // synchronously after every commit, so each entry is one committed frame
  // in order — the entry at the reset index is the FIRST frame the user sees
  // after the click.
  function renderWithFrameProbe() {
    const frames: NavFrame[] = [];
    render(
      <Profiler
        id="nav-loading-probe"
        onRender={() => {
          frames.push({
            skeleton:
              document.querySelector('[data-testid="skeleton-row"]') !== null,
            staleFolderCard: (document.body.textContent ?? "").includes(
              "Folder 1",
            ),
          });
        }}
      >
        <FolderSelectionScreen
          token="test-token"
          onSelectFolder={vi.fn()}
          initialFolderId="folderB"
          initialFolderHistory={[{ id: "root", name: "My Drive" }]}
        />
      </Profiler>,
    );
    return frames;
  }

  async function loadFolderOne() {
    await waitFor(() => {
      expect(deferredCalls).toHaveLength(1);
    });
    await act(async () => {
      deferredCallAt(0).resolve([{ id: "f1", name: "Folder 1" }]);
      await Promise.resolve();
    });
    await screen.findByText("Folder 1");
  }

  it("breadcrumb click commits the skeleton first, never the previous folder's card (P2-10-5)", async () => {
    const frames = renderWithFrameProbe();
    await loadFolderOne();
    expect(document.querySelector('[data-testid="skeleton-row"]')).toBeNull();

    const before = frames.length;
    fireEvent.click(screen.getByRole("button", { name: "My Drive" }));

    const firstFrame = frames[before];
    expect(firstFrame).toBeDefined();
    expect(firstFrame?.skeleton).toBe(true);
    expect(firstFrame?.staleFolderCard).toBe(false);
  });

  it("Back-pop commits the skeleton first, never the previous folder's card (P2-10-5)", async () => {
    const frames = renderWithFrameProbe();
    await loadFolderOne();
    expect(document.querySelector('[data-testid="skeleton-row"]')).toBeNull();

    const before = frames.length;
    fireEvent.click(backButton());

    const firstFrame = frames[before];
    expect(firstFrame).toBeDefined();
    expect(firstFrame?.skeleton).toBe(true);
    expect(firstFrame?.staleFolderCard).toBe(false);
  });
});

describe("FolderSelectionScreen parent-walk token/abort parity (P2-10-6)", () => {
  beforeEach(() => {
    deferredCalls = [];
    vi.clearAllMocks();
    installListFolderChildrenMock();
    mocks.driveApi.searchFolders.mockResolvedValue([]);
    mocks.driveApi.getFileName.mockResolvedValue(null);
    mocks.getValidToken.mockResolvedValue("test-token");
  });

  afterEach(() => {
    cleanup();
  });

  it("Back parent-walk passes the refreshed token and an abort signal to both Drive calls (parity with fetchFolders/search)", async () => {
    mocks.getValidToken.mockResolvedValue("fresh-token");
    mocks.driveApi.getFileParents.mockResolvedValue(["parentX"]);
    mocks.driveApi.getFileName.mockResolvedValue("Parent X");

    render(
      <FolderSelectionScreen
        token="test-token"
        onSelectFolder={vi.fn()}
        initialFolderId="folderB"
        initialFolderHistory={[]}
        appRootFolder="other-root"
      />,
    );
    await waitFor(() => {
      expect(deferredCalls).toHaveLength(1);
    });
    await act(async () => {
      deferredCallAt(0).resolve([]);
      await Promise.resolve();
    });

    fireEvent.click(backButton());
    await waitFor(() => {
      expect(mocks.driveApi.getFileParents).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(mocks.driveApi.getFileName).toHaveBeenCalled();
    });

    expect(mocks.driveApi.getFileParents).toHaveBeenCalledWith(
      "fresh-token",
      "folderB",
      expect.anything(),
    );
    expect(mocks.driveApi.getFileName).toHaveBeenCalledWith(
      "fresh-token",
      "parentX",
      expect.anything(),
    );
  });
});
