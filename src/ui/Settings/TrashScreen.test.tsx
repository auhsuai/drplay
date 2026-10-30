// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Profiler } from "react";
import { TrashScreen } from "./TrashScreen";
import { TrashItemRow } from "./TrashItemRow";
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
    "Music",
    "Folder",
    "Check",
    "Minus",
  ];
  // Render the className so tests can detect icon swaps (spinner vs idle).
  const Stub = (props: { className?: string }) => (
    <span className={props.className} />
  );
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

// Shape the mocked fetch resolves with. size/date stay optional so the
// "metadata missing" path (today's real getTrashedFiles fields mask) and the
// "metadata present" path (row formatting) are both testable.
type TrashItemInput = {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  trashedTime?: string;
  appProperties?: Record<string, string>;
};

type DeferredCall = {
  resolve: (value: TrashItemInput[]) => void;
  reject: (err: unknown) => void;
};

let deferredCalls: DeferredCall[] = [];

// Keep the fetch pending until the test resolves it, so isLoading stays true
// and the skeleton branch remains on screen.
function installGetTrashedFilesMock() {
  mocks.getTrashedFiles.mockImplementation(
    () =>
      new Promise<TrashItemInput[]>((resolve, reject) => {
        deferredCalls.push({ resolve, reject });
      }),
  );
}

function renderScreen() {
  return render(<TrashScreen token="test-token" onClose={vi.fn()} />);
}

// Rows are flat divs without a button role: find the container structurally.
function rowFor(name: string): HTMLElement {
  const row = screen.getByText(name).closest('[data-testid="trash-row"]');
  if (row === null) throw new Error(`row for ${name} not found`);
  return row as HTMLElement;
}

function rowCheckbox(name: string): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>("checkbox", { name });
}

// Destructive actions ask through the in-app ConfirmDialog, not window.confirm
// (the Tauri dialog plugin shadows window.confirm with an async shim that
// invokes a command the Rust plugin no longer registers, so it can never
// resolve). The modal is found by the title it derives from the action, and
// driven through the buttons it actually renders.
function confirmModal(title: string): HTMLElement {
  return screen.getByRole("dialog", { name: title });
}

function clickModalButton(title: string, label: string) {
  fireEvent.click(
    within(confirmModal(title)).getByRole("button", { name: label }),
  );
}

// Confirm the open modal and flush the async action it starts.
async function confirmModalAction(title: string) {
  await act(async () => {
    clickModalButton(title, "common.delete");
    await Promise.resolve();
  });
}

function selectRow(name: string) {
  fireEvent.click(rowCheckbox(name));
}

async function renderWithItems(items: TrashItemInput[], onClose = vi.fn()) {
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

  it("keeps the loading skeleton rows at their natural height (h-full wrapper, no flex-1, no h-full container)", async () => {
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
      expect(row.className).not.toContain("flex-1");
    }
    const row = rows[0];
    if (row === undefined) throw new Error("expected skeleton row");
    const wrapper = row.parentElement;
    expect(wrapper).not.toBeNull();
    if (wrapper) {
      // Flat list container (no gap): rows carry their own hairline divider.
      expect(wrapper.className).toContain("flex flex-col");
      expect(wrapper.className).not.toContain("gap-");
      expect(wrapper.className).not.toContain("h-full");
    }
  });
});

describe("TrashScreen flat list layout", () => {
  beforeEach(() => {
    deferredCalls = [];
    vi.clearAllMocks();
    installGetTrashedFilesMock();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders flat rows with a hairline divider instead of per-row cards", async () => {
    await renderWithItems([
      { id: "f1", name: "Track 1", mimeType: "audio/mpeg" },
    ]);

    const row = rowFor("Track 1");
    expect(row.className).toContain("h-12");
    expect(row.className).toContain("border-b");
    expect(row.className).not.toContain("rounded-xl");
    expect(row.className.split(/\s+/)).not.toContain("p-3");
  });

  it("shows the 30-day note under the title instead of the warning banner + menu", async () => {
    await renderWithItems([
      { id: "f1", name: "Track 1", mimeType: "audio/mpeg" },
    ]);

    const note = screen.getByText("settings.trash_warning");
    expect(note.className).toContain("text-xs");
    expect(note.className).toContain("text-gray-500");
    expect(document.getElementById("trash-title")?.textContent).toBe(
      "settings.trash",
    );
    expect(screen.queryByText("settings.trash_desc")).toBeNull();
    expect(screen.queryByText("menu.select_multiple")).toBeNull();
  });

  it("falls back to — for the deleted-date and size columns when Drive returns no such fields", async () => {
    await renderWithItems([
      { id: "f1", name: "Track 1", mimeType: "audio/mpeg" },
    ]);

    expect(screen.getAllByText("—")).toHaveLength(2);
  });

  it("keeps the row action cluster revealable by hover and keyboard focus", async () => {
    await renderWithItems([
      { id: "f1", name: "Track 1", mimeType: "audio/mpeg" },
    ]);

    const row = rowFor("Track 1");
    expect(row.className).toContain("group");
    const actions = row.querySelector('[class*="group-hover:opacity-100"]');
    expect(actions).not.toBeNull();
    const actionsEl = actions as HTMLElement;
    expect(actionsEl.className).toContain("opacity-0");
    expect(actionsEl.className).toContain("group-focus-within:opacity-100");
    expect(
      within(row).getByRole("button", { name: "settings.restore" }),
    ).not.toBeNull();
    expect(
      within(row).getByRole("button", { name: "settings.trash_delete_item" }),
    ).not.toBeNull();
  });
});

describe("TrashScreen selection + select all", () => {
  beforeEach(() => {
    deferredCalls = [];
    vi.clearAllMocks();
    installGetTrashedFilesMock();
  });

  afterEach(() => {
    cleanup();
  });

  it("hides the bulk toolbar until something is checked", async () => {
    await renderWithItems([
      { id: "f1", name: "Track 1", mimeType: "audio/mpeg" },
      { id: "f2", name: "Track 2", mimeType: "audio/mpeg" },
    ]);

    expect(screen.queryByText("settings.trash_restore_selected")).toBeNull();
    expect(screen.queryByText("settings.trash_delete_selected")).toBeNull();
    expect(screen.getByText("settings.empty_trash")).not.toBeNull();
  });

  it("row checkbox toggles the selection and reveals the bulk toolbar", async () => {
    await renderWithItems([
      { id: "f1", name: "Track 1", mimeType: "audio/mpeg" },
      { id: "f2", name: "Track 2", mimeType: "audio/mpeg" },
    ]);

    selectRow("Track 1");

    expect(rowCheckbox("Track 1").checked).toBe(true);
    expect(rowCheckbox("Track 2").checked).toBe(false);
    expect(screen.getByText("1 common.selected")).not.toBeNull();
    expect(screen.getByText("settings.trash_restore_selected")).not.toBeNull();
    expect(screen.getByText("settings.trash_delete_selected")).not.toBeNull();
    expect(screen.queryByText("settings.empty_trash")).toBeNull();
  });

  it("select all checks every row; unselect all clears them", async () => {
    await renderWithItems([
      { id: "f1", name: "Track 1", mimeType: "audio/mpeg" },
      { id: "f2", name: "Track 2", mimeType: "audio/mpeg" },
    ]);

    fireEvent.click(
      screen.getByRole("checkbox", { name: "settings.trash_select_all" }),
    );

    expect(rowCheckbox("Track 1").checked).toBe(true);
    expect(rowCheckbox("Track 2").checked).toBe(true);
    expect(screen.getByText("2 common.selected")).not.toBeNull();

    fireEvent.click(
      screen.getByRole("checkbox", { name: "settings.trash_unselect_all" }),
    );

    expect(rowCheckbox("Track 1").checked).toBe(false);
    expect(rowCheckbox("Track 2").checked).toBe(false);
    expect(screen.queryByText("settings.trash_restore_selected")).toBeNull();
  });

  it("marks the select-all box indeterminate when only some rows are checked", async () => {
    await renderWithItems([
      { id: "f1", name: "Track 1", mimeType: "audio/mpeg" },
      { id: "f2", name: "Track 2", mimeType: "audio/mpeg" },
    ]);

    const selectAll = screen.getByRole<HTMLInputElement>("checkbox", {
      name: "settings.trash_select_all",
    });
    expect(selectAll.indeterminate).toBe(false);

    selectRow("Track 1");

    expect(selectAll.indeterminate).toBe(true);
    expect(selectAll.checked).toBe(false);
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

  it("bulk restore: 1 item fails -> other items still restored + list updates only succeeded", async () => {
    await renderWithItems([
      { id: "f1", name: "Track 1", mimeType: "audio/mpeg" },
      { id: "f2", name: "Track 2", mimeType: "audio/mpeg" },
    ]);
    selectRow("Track 1");
    selectRow("Track 2");
    expect(screen.getByText("2 common.selected")).toBeTruthy();

    mocks.driveApi.restoreFile.mockResolvedValueOnce({ id: "f1" });
    mocks.driveApi.restoreFile.mockRejectedValueOnce(new Error("drive 500"));

    await act(async () => {
      fireEvent.click(screen.getByText("settings.trash_restore_selected"));
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
    expect(screen.getByText("settings.trash_delete_selected")).toBeTruthy();
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
    selectRow("Track 1");
    selectRow("Track 2");

    const confirmSpy = vi.spyOn(window, "confirm");
    mocks.driveApi.permanentlyDeleteFile.mockResolvedValueOnce(true);
    mocks.driveApi.permanentlyDeleteFile.mockRejectedValueOnce(
      new Error("drive 500"),
    );

    await act(async () => {
      fireEvent.click(screen.getByText("settings.trash_delete_selected"));
      await Promise.resolve();
    });
    expect(
      within(confirmModal("settings.trash_delete_selected")).getByText(
        "settings.confirm_bulk_delete",
      ),
    ).toBeTruthy();
    await confirmModalAction("settings.trash_delete_selected");

    await waitFor(() => {
      expect(mocks.driveApi.permanentlyDeleteFile).toHaveBeenCalledTimes(2);
      expect(screen.queryByText("Track 1")).toBeNull();
      expect(screen.getByText("Track 2")).not.toBeNull();
      expect(mocks.showErrorToast).toHaveBeenCalledWith(
        "settings.bulk_delete_error_count",
      );
    });
    expect(screen.getByText("1 common.selected")).toBeTruthy();
    expect(screen.getByText("settings.trash_delete_selected")).toBeTruthy();
    const loggedMessages = mocks.captureError.mock.calls
      .map((call) => call[0].message)
      .join("\n");
    expect(loggedMessages).toContain("bulk-delete-item-failed");
    // Regression: the flow must never touch the native dialog shim again.
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("bulk delete: confirm cancelled -> no delete requests, selection kept (P2-05-3)", async () => {
    await renderWithItems([
      { id: "f1", name: "Track 1", mimeType: "audio/mpeg" },
      { id: "f2", name: "Track 2", mimeType: "audio/mpeg" },
    ]);
    selectRow("Track 1");
    const confirmSpy = vi.spyOn(window, "confirm");

    await act(async () => {
      fireEvent.click(screen.getByText("settings.trash_delete_selected"));
      await Promise.resolve();
    });

    expect(
      within(confirmModal("settings.trash_delete_selected")).getByText(
        "settings.confirm_bulk_delete",
      ),
    ).toBeTruthy();
    clickModalButton("settings.trash_delete_selected", "common.cancel");

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("dialog", { name: "settings.trash_delete_selected" }),
    ).toBeNull();
    expect(mocks.driveApi.permanentlyDeleteFile).not.toHaveBeenCalled();
    expect(screen.getByText("1 common.selected")).toBeTruthy();
    expect(screen.getByText("Track 1")).not.toBeNull();
    expect(screen.getByText("Track 2")).not.toBeNull();
  });

  it("bulk delete: a double click on confirm still sends exactly one request", async () => {
    await renderWithItems([
      { id: "f1", name: "Track 1", mimeType: "audio/mpeg" },
    ]);
    selectRow("Track 1");
    mocks.driveApi.permanentlyDeleteFile.mockResolvedValue(true);

    await act(async () => {
      fireEvent.click(screen.getByText("settings.trash_delete_selected"));
      await Promise.resolve();
    });

    const button = within(
      confirmModal("settings.trash_delete_selected"),
    ).getByRole("button", { name: "common.delete" });
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => {
      expect(mocks.driveApi.permanentlyDeleteFile).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText("Track 1")).toBeNull();
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
    const confirmSpy = vi.spyOn(window, "confirm");

    mocks.driveApi.permanentlyDeleteFile.mockResolvedValueOnce(true);
    mocks.driveApi.permanentlyDeleteFile.mockRejectedValueOnce(
      new Error("drive 500"),
    );

    await act(async () => {
      fireEvent.click(screen.getByText("settings.empty_trash"));
      await Promise.resolve();
    });
    expect(
      within(confirmModal("settings.empty_trash")).getByText(
        "settings.confirm_empty_trash",
      ),
    ).toBeTruthy();
    await confirmModalAction("settings.empty_trash");

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
    expect(confirmSpy).not.toHaveBeenCalled();
    const loggedMessages = mocks.captureError.mock.calls
      .map((call) => call[0].message)
      .join("\n");
    expect(loggedMessages).toContain("empty-trash-item-failed");
  });
});

describe("TrashScreen per-row restore state (P2-05-7)", () => {
  beforeEach(() => {
    deferredCalls = [];
    vi.clearAllMocks();
    installGetTrashedFilesMock();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("keeps row B disabled with its spinner until its own restore settles", async () => {
    render(<TrashScreen token="test-token" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(deferredCalls).toHaveLength(1);
    });
    await act(async () => {
      const call = deferredCalls[0];
      if (call === undefined) throw new Error("expected deferred call");
      call.resolve([
        { id: "f1", name: "Track 1", mimeType: "audio/mpeg" },
        { id: "f2", name: "Track 2", mimeType: "audio/mpeg" },
      ]);
      await Promise.resolve();
    });
    await screen.findByText("Track 1");

    const pendingRestores = new Map<string, () => void>();
    mocks.driveApi.restoreFile.mockImplementation(
      (_token: string, id: string) =>
        new Promise((resolve) => {
          pendingRestores.set(id, () => {
            resolve({ id });
          });
        }),
    );

    const restoreButtons = screen.getAllByRole("button", {
      name: "settings.restore",
    });
    expect(restoreButtons).toHaveLength(2);
    fireEvent.click(restoreButtons[0] as HTMLElement);
    fireEvent.click(restoreButtons[1] as HTMLElement);

    const restoreButtonFor = (name: string) =>
      within(rowFor(name)).getByRole("button", { name: "settings.restore" });

    expect(restoreButtonFor("Track 1").hasAttribute("disabled")).toBe(true);
    expect(restoreButtonFor("Track 2").hasAttribute("disabled")).toBe(true);
    expect(rowFor("Track 2").querySelector(".animate-spin")).not.toBeNull();

    // Row A finishes while row B is still in flight: B keeps its own
    // spinner/disabled state instead of being reset by A's completion.
    await act(async () => {
      pendingRestores.get("f1")?.();
      await Promise.resolve();
    });

    expect(screen.queryByText("Track 1")).toBeNull();
    expect(restoreButtonFor("Track 2").hasAttribute("disabled")).toBe(true);
    expect(rowFor("Track 2").querySelector(".animate-spin")).not.toBeNull();

    await act(async () => {
      pendingRestores.get("f2")?.();
      await Promise.resolve();
    });
    expect(screen.queryByText("Track 2")).toBeNull();
  });
});

describe("TrashScreen per-row permanent delete", () => {
  beforeEach(() => {
    deferredCalls = [];
    vi.clearAllMocks();
    installGetTrashedFilesMock();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("confirms, permanently deletes the row and prunes it from the selection", async () => {
    await renderWithItems([
      { id: "f1", name: "Track 1", mimeType: "audio/mpeg" },
      { id: "f2", name: "Track 2", mimeType: "audio/mpeg" },
    ]);
    selectRow("Track 1");
    const confirmSpy = vi.spyOn(window, "confirm");
    mocks.driveApi.permanentlyDeleteFile.mockResolvedValueOnce(true);

    await act(async () => {
      fireEvent.click(
        within(rowFor("Track 1")).getByRole("button", {
          name: "settings.trash_delete_item",
        }),
      );
      await Promise.resolve();
    });

    expect(
      within(confirmModal("settings.trash_delete_item")).getByText(
        "settings.trash_delete_confirm",
      ),
    ).toBeTruthy();
    await confirmModalAction("settings.trash_delete_item");

    // Regression: destructive flows go through the in-app dialog only.
    expect(confirmSpy).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(mocks.driveApi.permanentlyDeleteFile).toHaveBeenCalledWith(
        "test-token",
        "f1",
      );
      expect(screen.queryByText("Track 1")).toBeNull();
    });
    expect(mocks.driveApi.permanentlyDeleteFile).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Track 2")).not.toBeNull();
    expect(screen.queryByText("settings.trash_restore_selected")).toBeNull();
    expect(
      screen.queryByRole("dialog", { name: "settings.trash_delete_item" }),
    ).toBeNull();
  });

  it("cancelled confirm -> no delete request and the row stays", async () => {
    await renderWithItems([
      { id: "f1", name: "Track 1", mimeType: "audio/mpeg" },
    ]);
    const confirmSpy = vi.spyOn(window, "confirm");

    await act(async () => {
      fireEvent.click(
        within(rowFor("Track 1")).getByRole("button", {
          name: "settings.trash_delete_item",
        }),
      );
      await Promise.resolve();
    });

    clickModalButton("settings.trash_delete_item", "common.cancel");

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("dialog", { name: "settings.trash_delete_item" }),
    ).toBeNull();
    expect(mocks.driveApi.permanentlyDeleteFile).not.toHaveBeenCalled();
    expect(screen.getByText("Track 1")).not.toBeNull();
  });

  it("Escape on the confirm dialog cancels without deleting", async () => {
    await renderWithItems([
      { id: "f1", name: "Track 1", mimeType: "audio/mpeg" },
    ]);

    await act(async () => {
      fireEvent.click(
        within(rowFor("Track 1")).getByRole("button", {
          name: "settings.trash_delete_item",
        }),
      );
      await Promise.resolve();
    });
    expect(
      screen.getByRole("dialog", { name: "settings.trash_delete_item" }),
    ).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(
      screen.queryByRole("dialog", { name: "settings.trash_delete_item" }),
    ).toBeNull();
    expect(mocks.driveApi.permanentlyDeleteFile).not.toHaveBeenCalled();
    expect(screen.getByText("Track 1")).not.toBeNull();
  });

  it("failure -> captureError + toast and the row stays", async () => {
    await renderWithItems([
      { id: "f1", name: "Track 1", mimeType: "audio/mpeg" },
    ]);
    const confirmSpy = vi.spyOn(window, "confirm");
    mocks.driveApi.permanentlyDeleteFile.mockRejectedValueOnce(
      new Error("drive 500"),
    );

    await act(async () => {
      fireEvent.click(
        within(rowFor("Track 1")).getByRole("button", {
          name: "settings.trash_delete_item",
        }),
      );
      await Promise.resolve();
    });
    await confirmModalAction("settings.trash_delete_item");

    await waitFor(() => {
      expect(mocks.showErrorToast).toHaveBeenCalledWith(
        "settings.trash_delete_error",
      );
    });
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(screen.getByText("Track 1")).not.toBeNull();
    const loggedMessages = mocks.captureError.mock.calls
      .map((call) => call[0].message)
      .join("\n");
    expect(loggedMessages).toContain("delete-item-failed");
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

describe("TrashScreen debug skeleton trigger", () => {
  beforeEach(() => {
    deferredCalls = [];
    vi.clearAllMocks();
    installGetTrashedFilesMock();
  });

  afterEach(() => {
    cleanup();
  });

  function dispatchSkeleton(target: unknown = "trash") {
    act(() => {
      window.dispatchEvent(
        new CustomEvent(DEBUG_EVENTS.SKELETON, { detail: { target } }),
      );
    });
  }

  it("SKELETON target trash while the fetch is still pending -> skeleton stays on screen", async () => {
    renderScreen();
    await waitFor(() => {
      expect(deferredCalls).toHaveLength(1);
    });
    expect(screen.queryAllByTestId("skeleton-row")).not.toHaveLength(0);

    dispatchSkeleton();

    expect(screen.queryAllByTestId("skeleton-row")).not.toHaveLength(0);
    expect(screen.getByRole("status", { name: "loading" })).not.toBeNull();
    expect(screen.queryByText("settings.trash_empty")).toBeNull();
  });

  it("SKELETON target trash after items loaded -> list replaced by the skeleton", async () => {
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
    expect(screen.queryAllByTestId("skeleton-row")).toHaveLength(0);

    dispatchSkeleton();

    expect(screen.queryByText("Track 1")).toBeNull();
    expect(screen.queryAllByTestId("skeleton-row")).not.toHaveLength(0);
    expect(screen.getByRole("status", { name: "loading" })).not.toBeNull();
  });

  it("SKELETON with a non-trash target leaves the loaded list untouched", async () => {
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

    dispatchSkeleton("folders");

    expect(screen.getByText("Track 1")).not.toBeNull();
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

describe("TrashScreen dialog a11y (P2-05-6)", () => {
  beforeEach(() => {
    deferredCalls = [];
    vi.clearAllMocks();
    installGetTrashedFilesMock();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("exposes modal dialog semantics with the title as its accessible name", () => {
    renderScreen();

    const dialog = screen.getByRole("dialog", { name: "settings.trash" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe("trash-title");
    expect(document.getElementById("trash-title")?.textContent).toBe(
      "settings.trash",
    );
  });

  it("moves focus to the Close button on open and the button has an accessible name", () => {
    renderScreen();

    const closeButton = screen.getByRole("button", { name: "common.close" });
    expect(document.activeElement).toBe(closeButton);
  });

  it("Escape closes the dialog", () => {
    const onClose = vi.fn();
    render(<TrashScreen token="test-token" onClose={onClose} />);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape is ignored while a bulk delete is in flight", async () => {
    const onClose = vi.fn();
    await renderWithItems(
      [{ id: "f1", name: "Track 1", mimeType: "audio/mpeg" }],
      onClose,
    );
    selectRow("Track 1");
    mocks.driveApi.permanentlyDeleteFile.mockImplementation(
      () => new Promise<never>(() => undefined),
    );

    await act(async () => {
      fireEvent.click(screen.getByText("settings.trash_delete_selected"));
      await Promise.resolve();
    });
    await confirmModalAction("settings.trash_delete_selected");

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
    // The dialog owns Escape while its request is in flight: it must stay
    // open with the busy state instead of silently dropping the operation.
    const dialog = screen.getByRole("dialog", {
      name: "settings.trash_delete_selected",
    });
    expect(
      within(dialog).getByText("common.delete").closest("button"),
    ).toHaveProperty("disabled", true);
  });

  it("unmount removes the Escape listener", () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <TrashScreen token="test-token" onClose={onClose} />,
    );

    unmount();
    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("TrashItemRow semantics (checkbox replaces the row-as-button toggle)", () => {
  beforeEach(() => {
    deferredCalls = [];
    vi.clearAllMocks();
    installGetTrashedFilesMock();
  });

  afterEach(() => {
    cleanup();
  });

  it("rows are neither buttons nor tab stops; the checkbox carries the toggle", async () => {
    await renderWithItems([
      { id: "f1", name: "Track 1", mimeType: "audio/mpeg" },
    ]);

    expect(screen.queryByRole("button", { name: "Track 1" })).toBeNull();
    const row = rowFor("Track 1");
    expect(row.getAttribute("role")).toBeNull();
    expect(row.getAttribute("tabindex")).toBeNull();
    expect(rowCheckbox("Track 1")).not.toBeNull();
  });

  it("clicking a row checkbox selects exactly that row", async () => {
    await renderWithItems([
      { id: "f1", name: "Track 1", mimeType: "audio/mpeg" },
      { id: "f2", name: "Track 2", mimeType: "audio/mpeg" },
    ]);

    selectRow("Track 1");

    expect(screen.getByText("1 common.selected")).not.toBeNull();
    expect(rowCheckbox("Track 1").checked).toBe(true);
    expect(rowCheckbox("Track 2").checked).toBe(false);
  });
});

describe("TrashItemRow metadata columns", () => {
  afterEach(() => {
    cleanup();
  });

  it("formats size and modifiedTime when the row receives them", () => {
    const modifiedTime = "2026-01-02T00:00:00.000Z";
    render(
      <TrashItemRow
        item={{
          id: "f9",
          name: "Track 9",
          mimeType: "audio/mpeg",
          size: "1048576",
          modifiedTime,
        }}
        isSelected={false}
        isRestoring={false}
        isDeleting={false}
        onToggle={vi.fn()}
        onRestore={vi.fn(() => Promise.resolve())}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByText("1 MB")).not.toBeNull();
    expect(
      screen.getByText(
        new Date(modifiedTime).toLocaleDateString(undefined, {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
        }),
      ),
    ).not.toBeNull();
  });

  it("renders — for a folder (no size) and a malformed date", () => {
    render(
      <TrashItemRow
        item={{
          id: "d1",
          name: "Folder 1",
          mimeType: "application/vnd.google-apps.folder",
          modifiedTime: "not-a-date",
        }}
        isSelected={false}
        isRestoring={false}
        isDeleting={false}
        onToggle={vi.fn()}
        onRestore={vi.fn(() => Promise.resolve())}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getAllByText("—")).toHaveLength(2);
  });
});

// Row icon: videos are classified by the shared isVideoFile allowlist
// (src/utils/audioQuery.ts) and render the inline film SVG; every other
// non-folder keeps Music. Unknown extensions must never be classified video.
describe("TrashItemRow video icon", () => {
  const renderRow = (name: string, mimeType: string) =>
    render(
      <TrashItemRow
        item={{ id: "f1", name, mimeType }}
        isSelected={false}
        isRestoring={false}
        isDeleting={false}
        onToggle={vi.fn()}
        onRestore={vi.fn(() => Promise.resolve())}
        onDelete={vi.fn()}
      />,
    );

  afterEach(() => {
    cleanup();
  });

  it("renders the film SVG for a recognized video extension (movie.mkv)", () => {
    renderRow("movie.mkv", "video/x-matroska");
    const film = document.querySelector("svg.lucide-film");
    expect(film).not.toBeNull();
    expect(film?.getAttribute("viewBox")).toBe("0 0 24 24");
    // The film artwork is a real inline SVG, not a lucide stub: it carries
    // the rect/path artwork instead of the stub's empty span.
    expect(film?.querySelector("rect")).not.toBeNull();
  });

  it("renders Music for an audio file (song.mp3)", () => {
    renderRow("song.mp3", "audio/mpeg");
    expect(document.querySelector("svg.lucide-film")).toBeNull();
    // Music is a lucide stub in this suite: a <span> carrying the row's
    // icon class, not an svg.
    const row = screen
      .getByText("song.mp3")
      .closest('[data-testid="trash-row"]');
    expect(row?.querySelector("span.w-4")).not.toBeNull();
  });

  it("does not classify unknown or absent extensions as video", () => {
    renderRow("notes.txt", "text/plain");
    expect(document.querySelector("svg.lucide-film")).toBeNull();

    cleanup();
    renderRow("extensionless", "application/octet-stream");
    expect(document.querySelector("svg.lucide-film")).toBeNull();
  });
});

// Deleted-date fallback chain: deletedAt (exact, from the appProperties
// timestamp) → trashedTime (shared drives only) → modifiedTime (documented
// approximation) → "—". Never fabricate a timestamp.
// Zero-padded locale date, exactly as TrashItemRow.formatDeletedDate renders
// it (01/01/2026, not 1/1/2026). Kept as one expression so the assertions can
// never drift from the shipped formatter.
const deletedDate = (raw: string | Date): string =>
  new Date(raw).toLocaleDateString(undefined, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });

describe("TrashItemRow deleted-date fallback chain", () => {
  interface DateInput {
    deletedAt?: string;
    trashedTime?: string;
    modifiedTime?: string;
  }

  const renderRow = (name: string, fields: DateInput) => {
    render(
      <TrashItemRow
        item={{ id: "f1", name, mimeType: "audio/mpeg", ...fields }}
        isSelected={false}
        isRestoring={false}
        isDeleting={false}
        onToggle={vi.fn()}
        onRestore={vi.fn(() => Promise.resolve())}
        onDelete={vi.fn()}
      />,
    );
  };

  afterEach(() => {
    cleanup();
  });

  it("prefers deletedAt over trashedTime and modifiedTime", () => {
    const deletedAt = "2026-03-01T00:00:00.000Z";
    renderRow("Track", {
      deletedAt,
      trashedTime: "2026-05-01T00:00:00.000Z",
      modifiedTime: "2026-06-01T00:00:00.000Z",
    });
    expect(screen.getByText(deletedDate(deletedAt))).not.toBeNull();
    expect(screen.queryByText(deletedDate("2026-05-01"))).toBeNull();
  });

  it("falls back to trashedTime when deletedAt is absent", () => {
    const trashedTime = "2026-05-01T00:00:00.000Z";
    renderRow("Track", {
      trashedTime,
      modifiedTime: "2026-06-01T00:00:00.000Z",
    });
    expect(screen.getByText(deletedDate(trashedTime))).not.toBeNull();
  });

  it("falls back to modifiedTime when deletedAt and trashedTime are absent", () => {
    const modifiedTime = "2026-06-01T00:00:00.000Z";
    renderRow("Track", { modifiedTime });
    expect(screen.getByText(deletedDate(modifiedTime))).not.toBeNull();
  });

  it("renders — when nothing is available (never fabricates a date)", () => {
    renderRow("Track", {});
    // Date column renders "—"; size is a second "—" for a bare audio item.
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThanOrEqual(1);
  });
});

// Sticky header sorting: column headers drive a props-driven sort owned by
// TrashScreen. Defaults: Date added desc (newest first), Name asc, Size desc;
// clicking the active column toggles direction; aria-sort reflects the state
// on each column.
describe("Trash header sorting", () => {
  beforeEach(() => {
    deferredCalls = [];
    vi.clearAllMocks();
    installGetTrashedFilesMock();
  });

  afterEach(() => {
    cleanup();
  });

  it("clicking Name applies ascending (its default), clicking again toggles to descending (aria-sort)", async () => {
    await renderWithItems([
      { id: "f1", name: "Zed.mp3", mimeType: "audio/mpeg" },
      { id: "f2", name: "Alpha.mp3", mimeType: "audio/mpeg" },
    ]);

    // Default state: Date added is the active column (desc default), so Name
    // reports "none" initially. aria-sort lives on the columnheader wrapper.
    const nameColumn = screen
      .getByRole("button", { name: "settings.trash_col_name" })
      .closest('[role="columnheader"]');

    // Clicking Name applies its default direction (asc).
    fireEvent.click(
      screen.getByRole("button", { name: "settings.trash_col_name" }),
    );
    expect(nameColumn?.getAttribute("aria-sort")).toBe("ascending");

    // Clicking the active column toggles direction.
    fireEvent.click(
      screen.getByRole("button", { name: "settings.trash_col_name" }),
    );
    expect(nameColumn?.getAttribute("aria-sort")).toBe("descending");

    fireEvent.click(
      screen.getByRole("button", { name: "settings.trash_col_name" }),
    );
    expect(nameColumn?.getAttribute("aria-sort")).toBe("ascending");
  });

  it("Date column is active by default with aria-sort descending; other columns report none", async () => {
    await renderWithItems([
      { id: "f1", name: "Track.mp3", mimeType: "audio/mpeg" },
    ]);

    // Initial state: Date added is the active column (desc default per spec
    // §3.1); Name and Size report "none".
    const ariaSortOf = (label: string): string | null =>
      screen
        .getByRole("button", { name: label })
        .closest('[role="columnheader"]')
        ?.getAttribute("aria-sort") ?? null;
    expect(ariaSortOf("settings.trash_col_date_added")).toBe("descending");
    expect(ariaSortOf("settings.trash_col_name")).toBe("none");
    expect(ariaSortOf("settings.trash_col_size")).toBe("none");

    // Clicking Name activates it with its default (asc) and deactivates Date.
    fireEvent.click(
      screen.getByRole("button", { name: "settings.trash_col_name" }),
    );
    expect(ariaSortOf("settings.trash_col_name")).toBe("ascending");
    expect(ariaSortOf("settings.trash_col_date_added")).toBe("none");
  });

  it("orders rows by the chosen column: Date-added desc by default, toggle flips, Name applies asc", async () => {
    const alpha = "2026-02-01T00:00:00.000Z";
    const omega = "2026-02-03T00:00:00.000Z";
    const alphaDate = deletedDate(alpha);
    const omegaDate = deletedDate(omega);
    await renderWithItems([
      {
        id: "f1",
        name: "Alpha.mp3",
        mimeType: "audio/mpeg",
        appProperties: { deletedByDrPlayAt: alpha },
      },
      {
        id: "f2",
        name: "Omega.mp3",
        mimeType: "audio/mpeg",
        appProperties: { deletedByDrPlayAt: omega },
      },
    ]);

    // Default state is Date-added descending (newest first): Omega (Feb 3)
    // renders before Alpha (Feb 1) without any click.
    const initial = screen.getAllByTestId("trash-row");
    expect(initial[0]?.textContent).toContain(omegaDate);
    expect(initial[1]?.textContent).toContain(alphaDate);

    // Clicking the active Date header toggles to ascending: Alpha (Feb 1)
    // first.
    fireEvent.click(
      screen.getByRole("button", { name: "settings.trash_col_date_added" }),
    );
    const ascRows = screen.getAllByTestId("trash-row");
    expect(ascRows[0]?.textContent).toContain(alphaDate);
    expect(ascRows[1]?.textContent).toContain(omegaDate);

    // Third click toggles back to descending: Omega (Feb 3) first again.
    fireEvent.click(
      screen.getByRole("button", { name: "settings.trash_col_date_added" }),
    );
    const descRows = screen.getAllByTestId("trash-row");
    expect(descRows[0]?.textContent).toContain(omegaDate);
  });

  it("sorting does not break selection", async () => {
    await renderWithItems([
      { id: "f1", name: "Zed.mp3", mimeType: "audio/mpeg" },
      { id: "f2", name: "Alpha.mp3", mimeType: "audio/mpeg" },
    ]);

    selectRow("Zed.mp3");
    expect(screen.getByText("1 common.selected")).not.toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "settings.trash_col_name" }),
    );

    // Selection survives the re-order.
    expect(screen.getByText("1 common.selected")).not.toBeNull();
    expect(rowCheckbox("Zed.mp3").checked).toBe(true);
  });

  it("header date labels are hidden below the sm breakpoint like the row dates", async () => {
    await renderWithItems([
      { id: "f1", name: "Track.mp3", mimeType: "audio/mpeg" },
    ]);
    const dateColumn = screen
      .getByRole("button", { name: "settings.trash_col_date_added" })
      .closest('[role="columnheader"]');
    expect(dateColumn?.className).toContain("hidden sm:block");
  });

  it("keeps the select-all checkbox in the header alongside the column labels", async () => {
    await renderWithItems([
      { id: "f1", name: "Track.mp3", mimeType: "audio/mpeg" },
    ]);
    expect(
      screen.getByRole("checkbox", { name: "settings.trash_select_all" }),
    ).not.toBeNull();
    expect(screen.getByText("settings.trash_col_name")).not.toBeNull();
  });

  it("trash date rows sort on the same effective date the rows display (fallback chain)", async () => {
    const early = "2026-01-05T00:00:00.000Z";
    const late = "2026-01-25T00:00:00.000Z";
    const earlyDate = deletedDate(early);
    const lateDate = deletedDate(late);
    await renderWithItems([
      {
        id: "f1",
        name: "Fallback-early.mp3",
        mimeType: "audio/mpeg",
        trashedTime: early,
      },
      {
        id: "f2",
        name: "Fallback-late.mp3",
        mimeType: "audio/mpeg",
        trashedTime: late,
      },
    ]);

    // Default state is Date-added descending: late (Jan 25) first — sorted
    // on the trashedTime fallback, not only on deletedAt, with no click.
    const descRows = screen.getAllByTestId("trash-row");
    expect(descRows[0]?.textContent).toContain(lateDate);
    expect(descRows[1]?.textContent).toContain(earlyDate);

    // First click toggles to ascending: early (Jan 5) first.
    fireEvent.click(
      screen.getByRole("button", { name: "settings.trash_col_date_added" }),
    );
    const ascRows = screen.getAllByTestId("trash-row");
    expect(ascRows[0]?.textContent).toContain(earlyDate);
    expect(ascRows[1]?.textContent).toContain(lateDate);
  });

  it("sorts items deleted after this feature exactly like fallback rows (deletedAt path)", async () => {
    const early = "2026-01-05T00:00:00.000Z";
    const late = "2026-01-25T00:00:00.000Z";
    const earlyDate = deletedDate(early);
    const lateDate = deletedDate(late);
    await renderWithItems([
      {
        id: "f1",
        name: "Exact-late.mp3",
        mimeType: "audio/mpeg",
        appProperties: { deletedByDrPlayAt: late },
      },
      {
        id: "f2",
        name: "Exact-early.mp3",
        mimeType: "audio/mpeg",
        appProperties: { deletedByDrPlayAt: early },
      },
    ]);

    // Default desc (no click needed): late (Jan 25) first.
    const rows = screen.getAllByTestId("trash-row");
    expect(rows[0]?.textContent).toContain(lateDate);
    expect(rows[1]?.textContent).toContain(earlyDate);
  });
});
