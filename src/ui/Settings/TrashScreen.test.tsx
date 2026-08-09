// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Profiler } from "react";
import { TrashScreen } from "./TrashScreen";

// react-i18next has no initialized instance in the node test env, so stub
// useTranslation to return the fallback (or the key itself when absent).
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
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
  captureError: vi.fn(),
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
