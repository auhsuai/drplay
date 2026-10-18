// @vitest-environment jsdom
import type { ComponentProps } from "react";
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
import { RootFolderSetupFlow } from "./RootFolderSetupFlow";
import type { RootFolder } from "../../utils/rootFolders";
import en from "../../locales/en/translation.json";

vi.mock("react-i18next", () => {
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

// Slot pickers are real FolderSelectionScreen instances in production. The
// stub below exposes one deterministic button per folder so the flow tests can
// drive a slot selection (id + name) without standing up Drive.
vi.mock("./FolderSelectionScreen", () => ({
  FolderSelectionScreen: (props: {
    onSelectFolder: (folderId: string) => void;
    onSelectFolderWithName?: (folderId: string, folderName: string) => void;
    onCancel?: () => void;
    startAtDriveRoot?: boolean;
  }) => (
    <div
      data-testid="picker-stub"
      data-start-at-drive-root={String(props.startAtDriveRoot)}
    >
      {[
        { id: "id-1", name: "Alpha" },
        { id: "id-2", name: "Beta" },
        { id: "id-3", name: "Gamma" },
        { id: "id-4", name: "Delta" },
        { id: "id-5", name: "Epsilon" },
      ].map((folder) => (
        <button
          key={folder.id}
          onClick={() => {
            if (props.onSelectFolderWithName) {
              props.onSelectFolderWithName(folder.id, folder.name);
            } else {
              props.onSelectFolder(folder.id);
            }
          }}
        >
          {`pick-${folder.id}`}
        </button>
      ))}
      {props.onCancel && (
        <button onClick={props.onCancel}>picker-cancel</button>
      )}
    </div>
  ),
}));

vi.mock("../../utils/errorLog", () => ({ captureError: vi.fn() }));

const enText = en.folder_selection;

const onCommit = vi.fn<(roots: RootFolder[]) => Promise<boolean>>();
const onDone = vi.fn();
const onCancel = vi.fn();

beforeEach(() => {
  onCommit.mockReset();
  onCommit.mockResolvedValue(true);
  onDone.mockReset();
  onCancel.mockReset();
});

afterEach(() => {
  cleanup();
});

function renderFlow(
  overrides: Partial<ComponentProps<typeof RootFolderSetupFlow>> = {},
) {
  return render(
    <RootFolderSetupFlow
      token="test-token"
      currentRoots={[]}
      onCommit={onCommit}
      onDone={onDone}
      {...overrides}
    />,
  );
}

function slotButtons(): HTMLElement[] {
  return screen.queryAllByRole("button", { name: /^Folder \d+$/ });
}

function slotButton(index: number): HTMLElement {
  return screen.getByRole("button", {
    name: enText.folder_slot.replace("{{index}}", String(index)),
  });
}

function missingSlotButton(index: number): HTMLElement | null {
  return screen.queryByRole("button", {
    name: enText.folder_slot.replace("{{index}}", String(index)),
  });
}

function pickIntoSlot(index: number, folderId: string) {
  fireEvent.click(slotButton(index));
  expect(screen.getByTestId("picker-stub")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: `pick-${folderId}` }));
  expect(screen.queryByTestId("picker-stub")).toBeNull();
}

function settingsButton(): HTMLElement {
  return screen.getByRole("button", { name: enText.edit_roots });
}

function footerActionGroup(): HTMLElement {
  const group = settingsButton().nextElementSibling;
  expect(group).toBeTruthy();
  return group as HTMLElement;
}

function enterEditMode() {
  fireEvent.click(settingsButton());
}

function flowConfirmButton(): HTMLElement | null {
  return screen.queryByRole("button", { name: enText.confirm });
}

function openConfirmDialog(): HTMLElement {
  const confirm = flowConfirmButton();
  expect(confirm).toBeTruthy();
  fireEvent.click(confirm as HTMLElement);
  return screen.getByRole("dialog", { name: enText.confirm_roots_title });
}

function openSingleRootConfirmDialog(): HTMLElement {
  const confirm = flowConfirmButton();
  expect(confirm).toBeTruthy();
  fireEvent.click(confirm as HTMLElement);
  return screen.getByRole("dialog", { name: enText.confirm_root_title });
}

function expectNoSetupControls() {
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.queryByText(enText.multi_root_question)).toBeNull();
  expect(
    screen.queryByRole("button", { name: enText.additional_roots }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: enText.use_single_root }),
  ).toBeNull();
  expect(screen.queryByRole("button", { name: enText.continue })).toBeNull();
}

function multiRoots(total: number): RootFolder[] {
  return Array.from({ length: total }, (_, index) => ({
    id: `id-${String(index + 1)}`,
    name: `Root ${String(index + 1)}`,
  }));
}

function removeButtons(): HTMLElement[] {
  return screen.queryAllByRole("button", { name: enText.remove_root });
}

function changeButtons(): HTMLElement[] {
  return screen.queryAllByRole("button", { name: enText.change_root });
}

function changeButton(): HTMLElement {
  const button = changeButtons()[0];
  expect(button).toBeTruthy();
  return button as HTMLElement;
}

function addRootButton(): HTMLElement | null {
  return screen.queryByRole("button", { name: enText.add_root_folder });
}

function removeDialog(): HTMLElement {
  return screen.getByRole("dialog", { name: enText.remove_root_title });
}

function requestRemoveFromRow(index: number) {
  const button = removeButtons()[index];
  expect(button).toBeTruthy();
  fireEvent.click(button as HTMLElement);
  return removeDialog();
}

function rowContainer(index: number): HTMLElement {
  const row = slotButton(index).closest<HTMLElement>(
    '[data-testid="root-slot-row"]',
  );
  expect(row).toBeTruthy();
  return row as HTMLElement;
}

describe("RootFolderSetupFlow merged mode screen", () => {
  it("(1) first run starts in edit mode; picking a folder returns to the list and Confirm commits", async () => {
    renderFlow();

    expect(
      screen.queryByRole("button", { name: enText.edit_roots }),
    ).toBeNull();
    expect(slotButtons()).toHaveLength(1);
    expect(screen.getByText(enText.choose_root_folder)).toBeTruthy();
    expect(removeButtons()).toHaveLength(0);
    expect(changeButtons()).toHaveLength(0);
    expect(addRootButton()).toBeTruthy();
    expect(flowConfirmButton()).toBeNull();
    expectNoSetupControls();

    fireEvent.click(slotButton(1));
    expect(
      screen
        .getByTestId("picker-stub")
        .getAttribute("data-start-at-drive-root"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "pick-id-1" }));

    expect(screen.queryByTestId("picker-stub")).toBeNull();
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(flowConfirmButton()).toBeEnabled();
    expect(onCommit).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();

    const dialog = openSingleRootConfirmDialog();
    expect(within(dialog).getByText(enText.confirm_root_body)).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: enText.confirm }),
    );

    await waitFor(() => {
      expect(onCommit).toHaveBeenCalledTimes(1);
    });
    expect(onCommit).toHaveBeenCalledWith([{ id: "id-1", name: "Alpha" }]);
    await waitFor(() => {
      expect(onDone).toHaveBeenCalledTimes(1);
    });
  });

  it("(2) an existing multi-root config starts in view mode: static rows, no actions", () => {
    renderFlow({
      currentRoots: [
        { id: "root-a", name: "Root A" },
        { id: "root-b", name: "Root B" },
      ],
      onCancel,
    });

    expect(settingsButton().getAttribute("aria-pressed")).toBe("false");
    expect(settingsButton().className).toContain("h-10");
    expect(settingsButton().className).toContain("w-10");
    expect(footerActionGroup().className).toContain("min-h-10");
    expect(slotButtons()).toHaveLength(0);
    expect(screen.getByText("Root A")).toBeTruthy();
    expect(screen.getByText("Root B")).toBeTruthy();
    expect(removeButtons()).toHaveLength(0);
    expect(changeButtons()).toHaveLength(0);
    expect(addRootButton()).toBeNull();
    expect(flowConfirmButton()).toBeNull();
    expect(screen.queryByRole("button", { name: enText.cancel })).toBeNull();

    const row = screen.getAllByTestId("root-slot-row")[0] as HTMLElement;
    expect(row.className).not.toContain("hover:-translate-y-1");

    fireEvent.click(screen.getByText("Root A"));
    expect(screen.queryByTestId("picker-stub")).toBeNull();
    expect(removeDialogExists()).toBe(false);
    expectNoSetupControls();
  });

  it("(3) the settings button turns edit mode on: rows clickable, minus per row, add tile, Confirm", () => {
    renderFlow({
      currentRoots: [
        { id: "root-a", name: "Root A" },
        { id: "root-b", name: "Root B" },
      ],
      onCancel,
    });

    enterEditMode();

    expect(settingsButton().getAttribute("aria-pressed")).toBe("true");
    expect(settingsButton().className).toContain("bg-brand-primary/10");
    expect(settingsButton().className).toContain("h-10");
    expect(settingsButton().className).toContain("w-10");
    expect(footerActionGroup().className).toContain("min-h-10");
    expect(slotButtons()).toHaveLength(2);
    expect(removeButtons()).toHaveLength(2);
    expect(changeButtons()).toHaveLength(0);
    expect(addRootButton()).toBeTruthy();
    expect(flowConfirmButton()).toBeEnabled();
    expect(screen.getByRole("button", { name: enText.cancel })).toBeTruthy();

    fireEvent.click(slotButton(1));
    expect(
      screen
        .getByTestId("picker-stub")
        .getAttribute("data-start-at-drive-root"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "pick-id-2" }));
    expect(screen.getByText("Beta")).toBeTruthy();

    // Toggle off: view mode hides actions and footer actions but keeps the
    // staged draft.
    enterEditMode();
    expect(settingsButton().getAttribute("aria-pressed")).toBe("false");
    expect(slotButtons()).toHaveLength(0);
    expect(removeButtons()).toHaveLength(0);
    expect(changeButtons()).toHaveLength(0);
    expect(addRootButton()).toBeNull();
    expect(flowConfirmButton()).toBeNull();
    expect(screen.queryByRole("button", { name: enText.cancel })).toBeNull();
    expect(screen.getByText("Beta")).toBeTruthy();

    // Toggle back on: the staged value is still there and footer actions return.
    enterEditMode();
    expect(settingsButton().getAttribute("aria-pressed")).toBe("true");
    expect(slotButtons()).toHaveLength(2);
    expect(removeButtons()).toHaveLength(2);
    expect(flowConfirmButton()).toBeEnabled();
    expect(screen.getByRole("button", { name: enText.cancel })).toBeTruthy();
    expect(screen.getByText("Beta")).toBeTruthy();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("(4) a one-root view starts static; settings reveals Refresh and the pick stays staged until Confirm", async () => {
    renderFlow({
      currentRoots: [{ id: "root-1", name: "Only" }],
      onCancel,
    });

    expect(settingsButton().getAttribute("aria-pressed")).toBe("false");
    expect(slotButtons()).toHaveLength(0);
    expect(changeButtons()).toHaveLength(0);
    expect(removeButtons()).toHaveLength(0);
    expect(addRootButton()).toBeNull();
    expect(flowConfirmButton()).toBeNull();
    expect(screen.queryByRole("button", { name: enText.cancel })).toBeNull();
    expect(screen.getByText("Only")).toBeTruthy();

    fireEvent.click(screen.getByText("Only"));
    expect(screen.queryByTestId("picker-stub")).toBeNull();

    enterEditMode();

    expect(changeButtons()).toHaveLength(1);
    expect(removeButtons()).toHaveLength(0);
    expect(flowConfirmButton()).toBeEnabled();
    expect(screen.getByRole("button", { name: enText.cancel })).toBeTruthy();
    expect(addRootButton()).toBeTruthy();

    // Row click and Refresh share the same staged slot picker.
    fireEvent.click(slotButton(1));
    expect(screen.getByTestId("picker-stub")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "picker-cancel" }));
    expect(screen.queryByTestId("picker-stub")).toBeNull();
    expect(screen.getByText("Only")).toBeTruthy();

    fireEvent.click(changeButton());
    expect(
      screen
        .getByTestId("picker-stub")
        .getAttribute("data-start-at-drive-root"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "pick-id-2" }));

    expect(screen.queryByTestId("picker-stub")).toBeNull();
    expect(screen.getByText("Beta")).toBeTruthy();
    expect(flowConfirmButton()).toBeEnabled();
    expect(onCommit).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();

    const dialog = openSingleRootConfirmDialog();
    expect(within(dialog).getByText(enText.confirm_root_body)).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: enText.confirm }),
    );

    await waitFor(() => {
      expect(onCommit).toHaveBeenCalledTimes(1);
    });
    expect(onCommit).toHaveBeenCalledWith([{ id: "id-2", name: "Beta" }]);
    await waitFor(() => {
      expect(onDone).toHaveBeenCalledTimes(1);
    });
  });

  it("(5) row replacements follow click order and commit ordered Folder 1..N", async () => {
    renderFlow({ currentRoots: multiRoots(3), onCancel });
    enterEditMode();

    pickIntoSlot(3, "id-3");
    pickIntoSlot(1, "id-1");
    pickIntoSlot(2, "id-2");

    expect(screen.getByText("Gamma")).toBeTruthy();
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.getByText("Beta")).toBeTruthy();

    const dialog = openConfirmDialog();
    fireEvent.click(
      within(dialog).getByRole("button", { name: enText.confirm }),
    );

    await waitFor(() => {
      expect(onCommit).toHaveBeenCalledTimes(1);
    });
    expect(onCommit).toHaveBeenCalledWith([
      { id: "id-1", name: "Alpha" },
      { id: "id-2", name: "Beta" },
      { id: "id-3", name: "Gamma" },
    ]);
    await waitFor(() => {
      expect(onDone).toHaveBeenCalledTimes(1);
    });
  });

  it("(6) canceling a slot picker returns to edit mode and keeps other selections", () => {
    renderFlow({ currentRoots: multiRoots(2), onCancel });
    enterEditMode();

    pickIntoSlot(1, "id-1");
    fireEvent.click(slotButton(2));
    fireEvent.click(screen.getByRole("button", { name: "picker-cancel" }));

    expect(screen.queryByTestId("picker-stub")).toBeNull();
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.getByText("Root 2")).toBeTruthy();
    expect(settingsButton().getAttribute("aria-pressed")).toBe("true");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("(7) the confirm modal shows the dynamic count and Cancel/Escape keep the draft", () => {
    for (const total of [2, 3, 5]) {
      renderFlow({ currentRoots: multiRoots(total), onCancel });
      enterEditMode();

      const dialog = openConfirmDialog();
      expect(
        within(dialog).getByText(
          `You have selected ${String(total)} folders. These folders will become your root locations in DrPlay.`,
        ),
      ).toBeTruthy();

      fireEvent.click(
        within(dialog).getByRole("button", { name: enText.cancel }),
      );
      expect(screen.getByText("Root 1")).toBeTruthy();
      expect(onCommit).not.toHaveBeenCalled();

      openConfirmDialog();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(
        screen.queryByRole("dialog", { name: enText.confirm_roots_title }),
      ).toBeNull();
      expect(screen.getByText("Root 1")).toBeTruthy();
      expect(flowConfirmButton()).toBeEnabled();
      expect(onCommit).not.toHaveBeenCalled();

      cleanup();
    }
  });

  it("(8) Confirm commits the ordered draft exactly once", async () => {
    renderFlow({
      currentRoots: [
        { id: "id-1", name: "Alpha" },
        { id: "id-2", name: "Beta" },
      ],
      onCancel,
    });
    enterEditMode();

    const dialog = openConfirmDialog();
    fireEvent.click(
      within(dialog).getByRole("button", { name: enText.confirm }),
    );

    await waitFor(() => {
      expect(onCommit).toHaveBeenCalledTimes(1);
    });
    expect(onCommit).toHaveBeenCalledWith([
      { id: "id-1", name: "Alpha" },
      { id: "id-2", name: "Beta" },
    ]);
    await waitFor(() => {
      expect(onDone).toHaveBeenCalledTimes(1);
    });
  });

  it("(9) a failed commit keeps the modal open, reports it and blocks double submits", async () => {
    let resolveCommit: (value: boolean) => void = () => {};
    onCommit.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveCommit = resolve;
        }),
    );

    renderFlow({ currentRoots: multiRoots(2), onCancel });
    enterEditMode();

    const dialog = openConfirmDialog();
    const modalConfirm = within(dialog).getByRole("button", {
      name: enText.confirm,
    });
    fireEvent.click(modalConfirm);
    fireEvent.click(modalConfirm);
    expect(onCommit).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveCommit(false);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe(
        enText.roots_commit_failed,
      );
    });
    expect(onDone).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", { name: enText.confirm_roots_title }),
    ).toBeTruthy();
  });

  it("(10) first run is edit mode; Cancel shows only with onCancel and Escape cancels", () => {
    const { unmount } = renderFlow({ onCancel });
    expect(
      screen.queryByRole("button", { name: enText.edit_roots }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: enText.cancel })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: enText.cancel }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(2);
    unmount();

    renderFlow();
    expect(
      screen.queryByRole("button", { name: enText.edit_roots }),
    ).toBeNull();
    expect(addRootButton()).toBeTruthy();
    expect(screen.queryByRole("button", { name: enText.cancel })).toBeNull();
    expect(screen.queryByRole("button", { name: en.common.close })).toBeNull();
  });

  it("(11) view hides footer actions; edit multi shows Cancel + Confirm and Cancel calls onCancel", () => {
    renderFlow({ currentRoots: multiRoots(2), onCancel });
    expect(screen.queryByRole("button", { name: enText.cancel })).toBeNull();
    expect(flowConfirmButton()).toBeNull();

    enterEditMode();
    expect(screen.getByRole("button", { name: enText.cancel })).toBeTruthy();
    expect(flowConfirmButton()).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: enText.cancel }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("(12) adding from first run appends root 1 and enters multi mode with Confirm", () => {
    renderFlow();

    const add = addRootButton();
    expect(add).toBeTruthy();
    expect((add as HTMLElement).textContent).toBe("");
    expect((add as HTMLElement).querySelector("svg")).not.toBeNull();
    expect((add as HTMLElement).className).toContain("bg-amber-100");
    expect((add as HTMLElement).className).toContain("w-12");
    expect((add as HTMLElement).className).toContain("h-12");
    expect((add as HTMLElement).parentElement?.className).toContain("ml-4");

    fireEvent.click(add as HTMLElement);
    expect(
      screen
        .getByTestId("picker-stub")
        .getAttribute("data-start-at-drive-root"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "pick-id-1" }));

    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(slotButtons()).toHaveLength(1);
    expect(changeButtons()).toHaveLength(1);
    expect(removeButtons()).toHaveLength(0);
    expect(flowConfirmButton()).toBeEnabled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("(13) canceling the add picker changes nothing", () => {
    renderFlow({ currentRoots: [{ id: "root-a", name: "Root A" }], onCancel });
    enterEditMode();

    fireEvent.click(addRootButton() as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "picker-cancel" }));

    expect(screen.queryByTestId("picker-stub")).toBeNull();
    expect(slotButtons()).toHaveLength(1);
    expect(screen.getByText("Root A")).toBeTruthy();
    expect(flowConfirmButton()).toBeEnabled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("(14) adding a duplicate root shows the alert and disables Confirm", () => {
    renderFlow({ currentRoots: [{ id: "id-1", name: "Alpha" }], onCancel });
    enterEditMode();

    fireEvent.click(addRootButton() as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "pick-id-1" }));

    expect(slotButtons()).toHaveLength(2);
    expect(screen.getByRole("alert").textContent).toBe(enText.roots_duplicate);
    expect(flowConfirmButton()).toBeDisabled();
    expect(removeButtons()).toHaveLength(2);
  });

  it("(15) replacing a row with a duplicate shows the alert and disables Confirm", () => {
    renderFlow({ currentRoots: multiRoots(2), onCancel });
    enterEditMode();

    pickIntoSlot(2, "id-1");

    expect(screen.getByRole("alert").textContent).toBe(enText.roots_duplicate);
    expect(flowConfirmButton()).toBeDisabled();

    pickIntoSlot(2, "id-2");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(flowConfirmButton()).toBeEnabled();
  });

  it("(16) adding a second root switches to multi mode and commits in order", async () => {
    renderFlow({ currentRoots: [{ id: "root-a", name: "Root A" }], onCancel });
    enterEditMode();

    fireEvent.click(addRootButton() as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "pick-id-2" }));

    expect(slotButtons()).toHaveLength(2);
    expect(screen.getByText("Root A")).toBeTruthy();
    expect(screen.getByText("Beta")).toBeTruthy();
    expect(removeButtons()).toHaveLength(2);
    expect(changeButtons()).toHaveLength(0);

    const dialog = openConfirmDialog();
    expect(
      within(dialog).getByText(
        "You have selected 2 folders. These folders will become your root locations in DrPlay.",
      ),
    ).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: enText.confirm }),
    );

    await waitFor(() => {
      expect(onCommit).toHaveBeenCalledTimes(1);
    });
    expect(onCommit).toHaveBeenCalledWith([
      { id: "root-a", name: "Root A" },
      { id: "id-2", name: "Beta" },
    ]);
  });

  it("(17) the add tile is visible only in edit mode and is hidden at five roots", () => {
    renderFlow({ currentRoots: multiRoots(4), onCancel });
    expect(addRootButton()).toBeNull();
    enterEditMode();
    expect(addRootButton()).toBeTruthy();
    cleanup();

    renderFlow({ currentRoots: multiRoots(5), onCancel });
    enterEditMode();
    expect(addRootButton()).toBeNull();
    expect(slotButtons()).toHaveLength(5);
  });

  it("(18) canceling the remove dialog keeps the root", () => {
    renderFlow({ currentRoots: multiRoots(2), onCancel });
    enterEditMode();

    const dialog = requestRemoveFromRow(0);
    expect(within(dialog).getByText(enText.remove_root_body)).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: enText.cancel }),
    );

    expect(
      screen.queryByRole("dialog", { name: enText.remove_root_title }),
    ).toBeNull();
    expect(slotButtons()).toHaveLength(2);
    expect(screen.getByText("Root 1")).toBeTruthy();
    expect(flowConfirmButton()).toBeEnabled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("(19) confirming a removal deletes the row, reindexes the rest and stays staged", () => {
    renderFlow({ currentRoots: multiRoots(3), onCancel });
    enterEditMode();

    const dialog = requestRemoveFromRow(1);
    fireEvent.click(
      within(dialog).getByRole("button", { name: enText.confirm }),
    );

    expect(
      screen.queryByRole("dialog", { name: enText.remove_root_title }),
    ).toBeNull();
    expect(slotButtons()).toHaveLength(2);
    expect(screen.getByText("Root 1")).toBeTruthy();
    expect(screen.getByText("Root 3")).toBeTruthy();
    expect(screen.queryByText("Root 2")).toBeNull();
    expect(slotButton(1)).toBeTruthy();
    expect(slotButton(2)).toBeTruthy();
    expect(missingSlotButton(3)).toBeNull();
    expect(settingsButton().getAttribute("aria-pressed")).toBe("true");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("(20) deleting down to one root keeps edit mode and Confirm and uses the single-root copy", async () => {
    renderFlow({ currentRoots: multiRoots(2), onCancel });
    enterEditMode();

    const deleteDialog = requestRemoveFromRow(0);
    fireEvent.click(
      within(deleteDialog).getByRole("button", { name: enText.confirm }),
    );

    expect(slotButtons()).toHaveLength(1);
    expect(screen.getByText("Root 2")).toBeTruthy();
    expect(removeButtons()).toHaveLength(0);
    expect(changeButtons()).toHaveLength(1);
    expect(flowConfirmButton()).toBeEnabled();
    expect(settingsButton().getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: enText.cancel })).toBeTruthy();

    const dialog = openSingleRootConfirmDialog();
    expect(
      screen.queryByRole("dialog", { name: enText.confirm_roots_title }),
    ).toBeNull();
    expect(within(dialog).getByText(enText.confirm_root_body)).toBeTruthy();
    expect(within(dialog).getByText(enText.confirm_root_title)).toBeTruthy();

    fireEvent.click(
      within(dialog).getByRole("button", { name: enText.confirm }),
    );
    await waitFor(() => {
      expect(onCommit).toHaveBeenCalledTimes(1);
    });
    expect(onCommit).toHaveBeenCalledWith([{ id: "id-2", name: "Root 2" }]);
    await waitFor(() => {
      expect(onDone).toHaveBeenCalledTimes(1);
    });
  });

  it("(21) after a 2 to 1 deletion the change trigger stages a slot replacement", async () => {
    renderFlow({ currentRoots: multiRoots(2), onCancel });
    enterEditMode();

    const deleteDialog = requestRemoveFromRow(0);
    fireEvent.click(
      within(deleteDialog).getByRole("button", { name: enText.confirm }),
    );

    fireEvent.click(changeButton());
    expect(
      screen
        .getByTestId("picker-stub")
        .getAttribute("data-start-at-drive-root"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "pick-id-3" }));

    expect(screen.queryByTestId("picker-stub")).toBeNull();
    expect(screen.getByText("Gamma")).toBeTruthy();
    expect(flowConfirmButton()).toBeEnabled();
    expect(onCommit).not.toHaveBeenCalled();

    const dialog = openSingleRootConfirmDialog();
    expect(within(dialog).getByText(enText.confirm_root_body)).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: enText.confirm }),
    );
    await waitFor(() => {
      expect(onCommit).toHaveBeenCalledTimes(1);
    });
    expect(onCommit).toHaveBeenCalledWith([{ id: "id-3", name: "Gamma" }]);
  });

  it("(22) the row lifts as one unit in edit mode and the red Minus travels with it", () => {
    renderFlow({ currentRoots: multiRoots(2), onCancel });
    enterEditMode();

    const row = rowContainer(1);
    expect(row.className).toContain("hover:-translate-y-1");
    expect(row.className).toContain("hover:shadow-md");
    expect(row.className).toContain("group");

    const minus = removeButtons()[0] as HTMLElement;
    expect(minus.className).toContain("text-red-600");
    expect(row.contains(minus)).toBe(true);
  });

  it("(23) Escape closes only the remove dialog", () => {
    renderFlow({ currentRoots: multiRoots(2), onCancel });
    enterEditMode();

    requestRemoveFromRow(0);
    fireEvent.keyDown(window, { key: "Escape" });

    expect(
      screen.queryByRole("dialog", { name: enText.remove_root_title }),
    ).toBeNull();
    expect(slotButtons()).toHaveLength(2);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("(24) Escape with no overlay open still cancels the setup", () => {
    renderFlow({ currentRoots: multiRoots(2), onCancel });

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

function removeDialogExists(): boolean {
  return (
    screen.queryByRole("dialog", { name: enText.remove_root_title }) !== null
  );
}
