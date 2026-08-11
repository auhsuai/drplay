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
import { TrashScreen } from "./TrashScreen";
import { DEBUG_EVENTS } from "../debug/debugEvents";

// react-i18next has no initialized instance in the node test env, so stub
// useTranslation to return the fallback (or the key itself when absent).
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("lucide-react", () => {
  const icons = [
    "Trash2",
    "X",
    "RefreshCw",
    "LoaderCircle",
    "TriangleAlert",
    "FileHeadphone",
    "Folder",
    "Check",
    "SquareCheckBig",
    "Ellipsis",
  ];
  const Stub = () => null;
  return Object.fromEntries(icons.map((n) => [n, Stub]));
});

const mocks = vi.hoisted(() => ({
  driveApi: {
    restoreFile: vi.fn(),
    permanentlyDeleteFile: vi.fn(),
    FOLDER_MIME: "application/vnd.google-apps.folder",
  },
  getTrashedFiles: vi.fn(),
  showErrorToast: vi.fn(),
  showSuccessToast: vi.fn(),
  captureError:
    vi.fn<(args: { level: string; source: string; message: string }) => void>(),
}));

vi.mock("../../utils/driveApi", () => mocks.driveApi);
vi.mock("../../utils/drivePagination", () => ({
  getTrashedFiles: mocks.getTrashedFiles,
}));
vi.mock("../../utils/simpleToast", () => ({
  showErrorToast: mocks.showErrorToast,
  showSuccessToast: mocks.showSuccessToast,
}));
vi.mock("../../utils/errorLog", () => ({ captureError: mocks.captureError }));

type DeferredCall = {
  resolve: (
    value: Array<{ id: string; name: string; mimeType: string }>,
  ) => void;
  reject: (err: unknown) => void;
};

let deferredCalls: DeferredCall[] = [];

// Keep the fetch pending until the test resolves it, so isLoading stays true
// and the skeleton branch remains on screen.
function installGetTrashedFilesMock() {
  mocks.getTrashedFiles.mockImplementation(
    () =>
      new Promise<Array<{ id: string; name: string; mimeType: string }>>(
        (resolve, reject) => {
          deferredCalls.push({ resolve, reject });
        },
      ),
  );
}

function renderScreen() {
  return render(<TrashScreen token="test-token" onClose={vi.fn()} />);
}

describe("TrashScreen skeleton loading", () => {
  beforeEach(() => {
    deferredCalls = [];
    vi.clearAllMocks();
    installGetTrashedFilesMock();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows 6 skeleton rows inside a status region instead of the spinner while loading", async () => {
    renderScreen();
    await waitFor(() => {
      expect(deferredCalls).toHaveLength(1);
    });

    const rows = await screen.findAllByTestId("skeleton-row");
    expect(rows).toHaveLength(6);
    expect(screen.getByRole("status", { name: "loading" })).toBeTruthy();
    expect(document.querySelector(".animate-spin")).toBeNull();
  });

  it("renders the real item list after loading finishes", async () => {
    renderScreen();
    await waitFor(() => {
      expect(deferredCalls).toHaveLength(1);
    });

    await act(async () => {
      const call = deferredCalls[0];
      if (call === undefined) throw new Error("expected deferred call");
      call.resolve([{ id: "f1", name: "Track 1", mimeType: "audio/mpeg" }]);
      await Promise.resolve();
    });

    expect(await screen.findByText("Track 1")).not.toBeNull();
    expect(screen.queryAllByTestId("skeleton-row")).toHaveLength(0);
    expect(document.querySelector(".animate-spin")).toBeNull();
  });

  it("keeps the empty state when no items are returned", async () => {
    renderScreen();
    await waitFor(() => {
      expect(deferredCalls).toHaveLength(1);
    });

    await act(async () => {
      const call = deferredCalls[0];
      if (call === undefined) throw new Error("expected deferred call");
      call.resolve([]);
      await Promise.resolve();
    });

    expect(await screen.findByText("settings.trash_empty")).not.toBeNull();
    expect(screen.queryAllByTestId("skeleton-row")).toHaveLength(0);
  });

  it('never flashes the "Trash is empty" state before the skeleton (first commit is already loading)', async () => {
    // The empty-state flash lives in the FIRST commit (isLoading starts
    // false) which testing-library's act() flushes away before returning.
    // Profiler.onRender fires synchronously after EVERY commit — reading the
    // DOM there captures each committed frame in order, including frame 1.
    const markers: string[] = [];
    const recordMarkers = () => {
      const hasSkeleton =
        document.querySelector('[data-testid="skeleton-row"]') !== null;
      const hasEmpty = (document.body.textContent ?? "").includes(
        "settings.trash_empty",
      );
      if (hasSkeleton && !markers.includes("skeleton"))
        markers.push("skeleton");
      if (hasEmpty && !markers.includes("empty")) markers.push("empty");
    };

    const { unmount } = render(
      <Profiler id="trash-frame-probe" onRender={recordMarkers}>
        <TrashScreen token="test-token" onClose={vi.fn()} />
      </Profiler>,
    );
    await act(async () => {});
    unmount();

    expect(markers).toContain("skeleton");
    expect(markers).not.toContain("empty");
  });

  it("stretch: the loading skeleton fills the whole list area (h-full wrapper, flex-1 rows)", async () => {
    renderScreen();
    await waitFor(() => {
      expect(deferredCalls).toHaveLength(1);
    });

    const status = screen.getByRole("status", { name: "loading" });
    // The list area is a definite-height flex child (overlay root is
    // fixed inset-0, dialog h-[70vh]) so h-full resolves here.
    expect(status.className).toContain("h-full");
    const rows = screen.getAllByTestId("skeleton-row");
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.className).toContain("flex-1");
    }
    const row = rows[0];
    if (row === undefined) throw new Error("expected skeleton row");
    const wrapper = row.parentElement;
    expect(wrapper).not.toBeNull();
    if (wrapper) {
      expect(wrapper.className).toContain("h-full");
    }
  });
});

describe("TrashScreen bulk operations", () => {
  beforeEach(() => {
    deferredCalls = [];
    vi.clearAllMocks();
    installGetTrashedFilesMock();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  async function renderWithItems(
    items: Array<{ id: string; name: string; mimeType: string }>,
    onClose = vi.fn(),
  ) {
    const view = render(<TrashScreen token="test-token" onClose={onClose} />);
    await waitFor(() => {
      expect(deferredCalls).toHaveLength(1);
    });
    await act(async () => {
      const call = deferredCalls[0];
      if (call === undefined) throw new Error("expected deferred call");
      call.resolve(items);
      await Promise.resolve();
    });
    await screen.findByText(items[0]?.name ?? "");
    return { onClose, ...view };
  }

  function enterSelectionMode() {
    const menuBtn = screen
      .getAllByRole("button")
      .find((b) => b.className.includes("p-1.5"));
    if (menuBtn === undefined) throw new Error("menu button not found");
    act(() => {
      fireEvent.click(menuBtn);
    });
    fireEvent.click(screen.getByText("menu.select_multiple"));
  }

  it("bulk restore: 1 item fails -> other items still restored + list updates only succeeded", async () => {
    await renderWithItems([
      { id: "f1", name: "Track 1", mimeType: "audio/mpeg" },
      { id: "f2", name: "Track 2", mimeType: "audio/mpeg" },
    ]);
    enterSelectionMode();
    fireEvent.click(screen.getByRole("button", { name: "Track 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Track 2" }));
    expect(screen.getByText("2 common.selected")).toBeTruthy();

    mocks.driveApi.restoreFile.mockResolvedValueOnce({ id: "f1" });
    mocks.driveApi.restoreFile.mockRejectedValueOnce(new Error("drive 500"));

    await act(async () => {
      fireEvent.click(screen.getByText("settings.restore"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mocks.driveApi.restoreFile).toHaveBeenCalledTimes(2);
      expect(screen.queryByText("Track 1")).toBeNull();
      expect(screen.getByText("Track 2")).not.toBeNull();
      expect(mocks.showErrorToast).toHaveBeenCalledWith(
        "settings.bulk_restore_error_count",
      );
    });
    expect(screen.getByText("1 common.selected")).toBeTruthy();
    expect(screen.getByText("common.delete")).toBeTruthy();
    const loggedMessages = mocks.captureError.mock.calls
      .map((call) => call[0].message)
      .join("\n");
    expect(loggedMessages).toContain("bulk-restore-item-failed");
  });

  it("bulk delete: partial failure -> selection cleared only for succeeded", async () => {
    await renderWithItems([
      { id: "f1", name: "Track 1", mimeType: "audio/mpeg" },
      { id: "f2", name: "Track 2", mimeType: "audio/mpeg" },
    ]);
    enterSelectionMode();
    fireEvent.click(screen.getByRole("button", { name: "Track 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Track 2" }));

    mocks.driveApi.permanentlyDeleteFile.mockResolvedValueOnce(true);
    mocks.driveApi.permanentlyDeleteFile.mockRejectedValueOnce(
      new Error("drive 500"),
    );

    await act(async () => {
      fireEvent.click(screen.getByText("common.delete"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mocks.driveApi.permanentlyDeleteFile).toHaveBeenCalledTimes(2);
      expect(screen.queryByText("Track 1")).toBeNull();
      expect(screen.getByText("Track 2")).not.toBeNull();
      expect(mocks.showErrorToast).toHaveBeenCalledWith(
        "settings.bulk_delete_error_count",
      );
    });
    expect(screen.getByText("1 common.selected")).toBeTruthy();
    expect(screen.getByText("common.delete")).toBeTruthy();
    const loggedMessages = mocks.captureError.mock.calls
      .map((call) => call[0].message)
      .join("\n");
    expect(loggedMessages).toContain("bulk-delete-item-failed");
  });

  it("empty trash: partial failure -> no onClose + succeeded items removed", async () => {
    const onClose = vi.fn();
    await renderWithItems(
      [
        { id: "f1", name: "Track 1", mimeType: "audio/mpeg" },
        { id: "f2", name: "Track 2", mimeType: "audio/mpeg" },
      ],
      onClose,
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);

    mocks.driveApi.permanentlyDeleteFile.mockResolvedValueOnce(true);
    mocks.driveApi.permanentlyDeleteFile.mockRejectedValueOnce(
      new Error("drive 500"),
    );

    await act(async () => {
      fireEvent.click(screen.getByText("settings.empty_trash"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mocks.driveApi.permanentlyDeleteFile).toHaveBeenCalledTimes(2);
      expect(screen.queryByText("Track 1")).toBeNull();
      expect(screen.getByText("Track 2")).not.toBeNull();
      expect(onClose).not.toHaveBeenCalled();
      expect(mocks.showSuccessToast).not.toHaveBeenCalled();
      expect(mocks.showErrorToast).toHaveBeenCalledWith(
        "settings.empty_trash_error_count",
      );
    });
    const loggedMessages = mocks.captureError.mock.calls
      .map((call) => call[0].message)
      .join("\n");
    expect(loggedMessages).toContain("empty-trash-item-failed");
  });
});

describe("TrashScreen debug empty trigger", () => {
  beforeEach(() => {
    deferredCalls = [];
    vi.clearAllMocks();
    installGetTrashedFilesMock();
  });

  afterEach(() => {
    cleanup();
  });

  function dispatchTrashEmpty() {
    act(() => {
      window.dispatchEvent(new CustomEvent(DEBUG_EVENTS.TRASH_EMPTY));
    });
  }

  it("dispatches TRASH_EMPTY while the fetch is still pending -> empty state, no skeleton", async () => {
    renderScreen();
    await waitFor(() => {
      expect(deferredCalls).toHaveLength(1);
    });
    expect(screen.queryAllByTestId("skeleton-row")).not.toHaveLength(0);

    dispatchTrashEmpty();

    expect(screen.getByText("settings.trash_empty")).not.toBeNull();
    expect(screen.queryAllByTestId("skeleton-row")).toHaveLength(0);
    expect(screen.queryByRole("status", { name: "loading" })).toBeNull();
  });

  it("dispatches TRASH_EMPTY after items loaded -> list replaced by the empty state", async () => {
    renderScreen();
    await waitFor(() => {
      expect(deferredCalls).toHaveLength(1);
    });
    await act(async () => {
      const call = deferredCalls[0];
      if (call === undefined) throw new Error("expected deferred call");
      call.resolve([{ id: "f1", name: "Track 1", mimeType: "audio/mpeg" }]);
      await Promise.resolve();
    });
    await screen.findByText("Track 1");

    dispatchTrashEmpty();

    expect(screen.getByText("settings.trash_empty")).not.toBeNull();
    expect(screen.queryByText("Track 1")).toBeNull();
    expect(screen.queryAllByTestId("skeleton-row")).toHaveLength(0);
  });

  it("unmount -> dispatching TRASH_EMPTY is a no-op (listener cleaned up)", async () => {
    const { unmount } = renderScreen();
    await waitFor(() => {
      expect(deferredCalls).toHaveLength(1);
    });

    unmount();
    expect(() => {
      dispatchTrashEmpty();
    }).not.toThrow();
  });
});
