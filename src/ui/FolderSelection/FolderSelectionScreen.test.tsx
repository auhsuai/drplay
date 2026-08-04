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
import { Profiler } from "react";
import { FolderSelectionScreen } from "./FolderSelectionScreen";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock("lucide-react", () => {
  const icons = [
    "Folder",
    "ArrowLeft",
    "HardDrive",
    "Check",
    "Search",
    "LoaderCircle",
  ];
  const Stub = () => null;
  return Object.fromEntries(icons.map((n) => [n, Stub]));
});

const mocks = vi.hoisted(() => ({
  driveApi: {
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
    await waitFor(() => expect(deferredCalls).toHaveLength(1));

    fireEvent.click(screen.getAllByRole("button")[BACK_BUTTON_INDEX]);
    await waitFor(() => expect(deferredCalls).toHaveLength(2));

    const newFolderFetch = deferredCalls[1];
    await act(async () => {
      newFolderFetch.resolve([{ id: "f1", name: "Folder 1" }]);
    });
    expect(screen.queryByText("Folder 1")).not.toBeNull();

    const staleFolderFetch = deferredCalls[0];
    expect(staleFolderFetch.signal?.aborted).toBe(true);
    await act(async () => {
      staleFolderFetch.resolve([{ id: "stale", name: "STALE" }]);
    });
    expect(screen.queryByText("STALE")).toBeNull();
    expect(screen.queryByText("Folder 1")).not.toBeNull();
  });

  it("aborts the in-flight fetch on unmount and never updates state afterward", async () => {
    const { unmount } = renderScreen();
    await waitFor(() => expect(deferredCalls).toHaveLength(1));

    unmount();

    const inFlight = deferredCalls[0];
    expect(inFlight.signal?.aborted).toBe(true);

    await act(async () => {
      inFlight.resolve([{ id: "late", name: "LATE" }]);
    });

    expect(mocks.showErrorToast).not.toHaveBeenCalled();
    expect(mocks.captureError).not.toHaveBeenCalled();
  });

  it("does not toast when the in-flight folder fetch is aborted by navigation", async () => {
    renderScreen();
    await waitFor(() => expect(deferredCalls).toHaveLength(1));

    fireEvent.click(screen.getAllByRole("button")[BACK_BUTTON_INDEX]);
    await waitFor(() => expect(deferredCalls).toHaveLength(2));

    await act(async () => {
      deferredCalls[0].reject(
        new DOMException("The operation was aborted", "AbortError"),
      );
      deferredCalls[1].resolve([{ id: "f1", name: "Folder 1" }]);
    });

    expect(mocks.showErrorToast).not.toHaveBeenCalled();
    expect(mocks.captureError).not.toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("failed-to-fetch-folders"),
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
      await waitFor(() => expect(deferredCalls).toHaveLength(1));
      expect(mocks.captureError).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "warn",
          source: "FolderSelectionScreen",
          message: expect.stringContaining("root-folder-read-failed"),
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
    await waitFor(() => expect(deferredCalls).toHaveLength(1));

    const rows = await screen.findAllByTestId("skeleton-row");
    expect(rows).toHaveLength(6);
    expect(screen.getByRole("status", { name: "loading" })).toBeTruthy();
    expect(document.querySelector(".animate-spin")).toBeNull();
  });

  it('keeps the "Searching deeper..." branch while an API search is in flight (no skeleton)', async () => {
    renderScreen();
    await waitFor(() => expect(deferredCalls).toHaveLength(1));

    fireEvent.change(screen.getByPlaceholderText("Search..."), {
      target: { value: "abc" },
    });
    await waitFor(() => expect(searchDeferredCalls).toHaveLength(1));

    expect(
      screen.getByText("folder_selection.searching_deeper"),
    ).not.toBeNull();
    expect(screen.queryAllByTestId("skeleton-row")).toHaveLength(0);
    expect(document.querySelector(".animate-spin")).toBeNull();
  });

  it("renders the real folder list once loading finishes", async () => {
    renderScreen();
    await waitFor(() => expect(deferredCalls).toHaveLength(1));

    await act(async () => {
      deferredCalls[0].resolve([{ id: "f1", name: "Folder 1" }]);
    });

    expect(await screen.findByText("Folder 1")).not.toBeNull();
    expect(screen.queryAllByTestId("skeleton-row")).toHaveLength(0);
  });

  it("keeps the empty state when no folders are returned", async () => {
    renderScreen();
    await waitFor(() => expect(deferredCalls).toHaveLength(1));

    await act(async () => {
      deferredCalls[0].resolve([]);
    });

    expect(await screen.findByText("drive.no_folders")).not.toBeNull();
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
        "drive.no_folders",
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

  it("grid: the loading skeleton mirrors the real folder grid (3-col, h-full, auto-rows-fr)", async () => {
    renderScreen();
    await waitFor(() => expect(deferredCalls).toHaveLength(1));

    const status = screen.getByRole("status", { name: "loading" });
    // The folder list is a definite-height flex child (overlay root is
    // fixed inset-0, dialog h-[75vh]) so h-full resolves here.
    expect(status.className).toContain("h-full");
    const rows = screen.getAllByTestId("skeleton-row");
    expect(rows).toHaveLength(6);
    // The skeleton container mirrors the real list container
    // (FolderSelectionScreen.tsx:393 grid grid-cols-1 sm:grid-cols-2
    // lg:grid-cols-3 gap-3) so the shape does not jump when data loads.
    const container = rows[0].parentElement!;
    expect(container.className).toContain(
      "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3",
    );
    expect(container.className).toContain("auto-rows-fr");
    expect(container.className).toContain("h-full");
  });

  it('never shows the empty "no folders" state while loading with a search query typed (API-search branch wins)', async () => {
    renderScreen();
    await waitFor(() => expect(deferredCalls).toHaveLength(1));

    // While the folder fetch is still pending, typing a query must not swap
    // into the empty state: the loading/API-search branches take precedence
    // over every empty-state branch (drive.no_folders).
    fireEvent.change(screen.getByPlaceholderText("Search..."), {
      target: { value: "abc" },
    });
    await waitFor(() => expect(searchDeferredCalls).toHaveLength(1));

    expect(screen.queryByText("drive.no_folders")).toBeNull();
    expect(screen.queryAllByTestId("skeleton-row").length).toBe(0);
    expect(
      screen.getByText("folder_selection.searching_deeper"),
    ).not.toBeNull();
  });
});
