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
const enCommon = en.common;

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

function multiRootToggle(): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>("checkbox", {
    name: enText.multi_root_question,
  });
}

function setMulti(enabled: boolean) {
  const toggle = multiRootToggle();
  if (toggle.checked !== enabled) fireEvent.click(toggle);
}

function continueFlow() {
  fireEvent.click(screen.getByRole("button", { name: enText.continue }));
}

function dropdownTrigger(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>("button", {
    name: enText.additional_roots,
  });
}

function isDropdownOpen(): boolean {
  return dropdownTrigger().getAttribute("aria-expanded") === "true";
}

function openDropdown() {
  fireEvent.click(dropdownTrigger());
  expect(isDropdownOpen()).toBe(true);
}

function setAdditionalCount(count: number) {
  openDropdown();
  fireEvent.click(screen.getByRole("button", { name: String(count) }));
  expect(isDropdownOpen()).toBe(false);
}

function enterEditor(count?: number) {
  setMulti(true);
  continueFlow();
  if (count !== undefined) setAdditionalCount(count);
}

function slotButton(index: number): HTMLElement {
  return screen.getByRole("button", {
    name: enText.folder_slot.replace("{{index}}", String(index)),
  });
}

function pickIntoSlot(index: number, folderId: string) {
  fireEvent.click(slotButton(index));
  expect(screen.getByTestId("picker-stub")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: `pick-${folderId}` }));
  expect(screen.queryByTestId("picker-stub")).toBeNull();
}

function editorConfirmButton(): HTMLElement {
  return screen.getByRole("button", { name: enText.confirm });
}

function openConfirmDialog(): HTMLElement {
  fireEvent.click(editorConfirmButton());
  return screen.getByRole("dialog", { name: enText.confirm_roots_title });
}

describe("RootFolderSetupFlow mode step", () => {
  it("(1) fresh setup defaults to single root and commits one folder from the picker", async () => {
    renderFlow();

    expect(screen.getByText(enText.multi_root_question)).toBeTruthy();
    expect(multiRootToggle().checked).toBe(false);
    expect(
      screen.queryByRole("button", { name: enText.additional_roots }),
    ).toBeNull();

    continueFlow();
    expect(screen.getByTestId("picker-stub")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "pick-id-1" }));

    await waitFor(() => {
      expect(onCommit).toHaveBeenCalledTimes(1);
    });
    expect(onCommit).toHaveBeenCalledWith([{ id: "id-1", name: "Alpha" }]);
    await waitFor(() => {
      expect(onDone).toHaveBeenCalledTimes(1);
    });
  });

  it("(2) an existing single root defaults to the toggle off and opens the single picker", () => {
    renderFlow({ currentRoots: [{ id: "root-1", name: "Only" }] });

    expect(multiRootToggle().checked).toBe(false);
    continueFlow();
    expect(screen.getByTestId("picker-stub")).toBeTruthy();
  });

  it("(3) an existing multi-root config defaults the toggle on and prefills the slots", () => {
    renderFlow({
      currentRoots: [
        { id: "root-a", name: "Root A" },
        { id: "root-b", name: "Root B" },
      ],
    });

    expect(multiRootToggle().checked).toBe(true);
    expect(dropdownTrigger().textContent).toContain("1");

    continueFlow();
    expect(screen.getByText("Root A")).toBeTruthy();
    expect(screen.getByText("Root B")).toBeTruthy();
  });

  it("(14) Cancel is only offered when the caller allows it (Settings), first-run has none", () => {
    const { unmount } = renderFlow({ onCancel });
    fireEvent.click(screen.getByRole("button", { name: enText.cancel }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(2);
    unmount();

    renderFlow();
    expect(screen.queryByRole("button", { name: enText.cancel })).toBeNull();
    expect(screen.queryByRole("button", { name: enCommon.close })).toBeNull();
  });
});

describe("RootFolderSetupFlow editor step", () => {
  it("(4) the dropdown drives the required slot count and disables the rest", () => {
    renderFlow();
    enterEditor();

    for (const [additional, total] of [
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
    ] as const) {
      setAdditionalCount(additional);
      for (let index = 1; index <= 5; index += 1) {
        const button = slotButton(index);
        if (index <= total) {
          expect(button).toBeEnabled();
        } else {
          expect(button).toBeDisabled();
        }
      }
    }

    setAdditionalCount(1);
    fireEvent.click(slotButton(3));
    expect(screen.queryByTestId("picker-stub")).toBeNull();
  });

  it("(5) Confirm stays disabled until every required slot is filled", () => {
    renderFlow();
    enterEditor();

    const confirm = editorConfirmButton();
    expect(confirm).toBeDisabled();
    expect(confirm.className).toContain("disabled:opacity-50");
    expect(confirm.className).toContain("disabled:cursor-not-allowed");

    pickIntoSlot(1, "id-1");
    expect(editorConfirmButton()).toBeDisabled();

    pickIntoSlot(2, "id-2");
    expect(editorConfirmButton()).toBeEnabled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("(6) duplicate required ids block Confirm and show the inline message until fixed", () => {
    renderFlow();
    enterEditor();

    pickIntoSlot(1, "id-1");
    pickIntoSlot(2, "id-1");

    expect(editorConfirmButton()).toBeDisabled();
    expect(screen.getByRole("alert").textContent).toBe(enText.roots_duplicate);

    pickIntoSlot(2, "id-2");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(editorConfirmButton()).toBeEnabled();
  });

  it("(7) slots are independent of click order and commit ordered Folder 1..N", async () => {
    renderFlow();
    enterEditor(2);

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

  it("(8) canceling a slot picker returns to the editor and keeps other selections", () => {
    renderFlow({
      currentRoots: [
        { id: "root-a", name: "Root A" },
        { id: "root-b", name: "Root B" },
      ],
    });
    continueFlow();

    fireEvent.click(slotButton(1));
    fireEvent.click(screen.getByRole("button", { name: "picker-cancel" }));

    expect(screen.queryByTestId("picker-stub")).toBeNull();
    expect(screen.getByText("Root A")).toBeTruthy();
    expect(screen.getByText("Root B")).toBeTruthy();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("(9) lowering the count hides staged extra slots from the commit", async () => {
    renderFlow();
    enterEditor(3);

    pickIntoSlot(1, "id-1");
    pickIntoSlot(2, "id-2");
    pickIntoSlot(3, "id-3");
    pickIntoSlot(4, "id-4");

    setAdditionalCount(1);
    expect(editorConfirmButton()).toBeEnabled();
    expect(screen.getByText("Gamma")).toBeTruthy();

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
      expect(onCommit).toHaveBeenCalledWith([
        { id: "id-1", name: "Alpha" },
        { id: "id-2", name: "Beta" },
      ]);
    });
  });

  it("(10) Use only one root folder discards the staged slots", async () => {
    renderFlow();
    enterEditor();
    pickIntoSlot(1, "id-1");

    fireEvent.click(
      screen.getByRole("button", { name: enText.use_single_root }),
    );
    fireEvent.click(screen.getByRole("button", { name: "pick-id-2" }));

    await waitFor(() => {
      expect(onCommit).toHaveBeenCalledTimes(1);
    });
    expect(onCommit).toHaveBeenCalledWith([{ id: "id-2", name: "Beta" }]);
    await waitFor(() => {
      expect(onDone).toHaveBeenCalledTimes(1);
    });
  });

  it("(11) the confirm modal shows the dynamic count and Cancel/Escape keep the draft", () => {
    const roots: RootFolder[] = [
      { id: "id-1", name: "Alpha" },
      { id: "id-2", name: "Beta" },
    ];

    for (const total of [2, 3, 5]) {
      renderFlow({
        currentRoots: Array.from({ length: total }, (_, index) => ({
          id: `id-${String(index + 1)}`,
          name: roots[index]?.name ?? `Folder ${String(index + 1)}`,
        })),
      });
      continueFlow();

      const dialog = openConfirmDialog();
      expect(
        within(dialog).getByText(
          `You have selected ${String(total)} folders. These folders will become your root locations in DrPlay.`,
        ),
      ).toBeTruthy();

      fireEvent.click(
        within(dialog).getByRole("button", { name: enText.cancel }),
      );
      expect(screen.getByText("Alpha")).toBeTruthy();
      expect(onCommit).not.toHaveBeenCalled();

      openConfirmDialog();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(
        screen.queryByRole("dialog", { name: enText.confirm_roots_title }),
      ).toBeNull();
      expect(screen.getByText("Alpha")).toBeTruthy();
      expect(onCommit).not.toHaveBeenCalled();

      cleanup();
    }
  });

  it("(12) Confirm commits the ordered required roots exactly once", async () => {
    renderFlow({
      currentRoots: [
        { id: "id-1", name: "Alpha" },
        { id: "id-2", name: "Beta" },
      ],
    });
    continueFlow();

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

  it("(15) the single-root picker starts at the real Drive root", () => {
    renderFlow();

    continueFlow();

    expect(
      screen
        .getByTestId("picker-stub")
        .getAttribute("data-start-at-drive-root"),
    ).toBe("true");
  });

  it("(16) the multi-root slot picker starts at the real Drive root", () => {
    renderFlow();
    enterEditor();

    fireEvent.click(slotButton(1));

    expect(
      screen
        .getByTestId("picker-stub")
        .getAttribute("data-start-at-drive-root"),
    ).toBe("true");
  });

  it("(13) a failed commit keeps the modal open, reports it and blocks double submits", async () => {
    let resolveCommit: (value: boolean) => void = () => {};
    onCommit.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveCommit = resolve;
        }),
    );

    renderFlow({
      currentRoots: [
        { id: "id-1", name: "Alpha" },
        { id: "id-2", name: "Beta" },
      ],
    });
    continueFlow();

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
});

describe("RootFolderSetupFlow additional roots dropdown", () => {
  it("(17) exposes aria-expanded and selecting an option updates the required count", () => {
    renderFlow();
    setMulti(true);

    expect(isDropdownOpen()).toBe(false);
    openDropdown();
    for (const option of [1, 2, 3, 4]) {
      expect(screen.getByRole("button", { name: String(option) })).toBeTruthy();
    }

    fireEvent.click(screen.getByRole("button", { name: "3" }));
    expect(isDropdownOpen()).toBe(false);
    expect(dropdownTrigger().textContent).toContain("3");

    continueFlow();
    expect(slotButton(4)).toBeEnabled();
    expect(slotButton(5)).toBeDisabled();
  });

  it("(18) clicking outside closes the menu", () => {
    renderFlow();
    setMulti(true);
    openDropdown();

    fireEvent.mouseDown(document.body);

    expect(isDropdownOpen()).toBe(false);
    expect(screen.queryByRole("button", { name: "1" })).toBeNull();
  });

  it("(19) Escape inside the open menu closes it without cancelling the flow", () => {
    renderFlow({ onCancel });
    setMulti(true);
    const trigger = dropdownTrigger();
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(trigger, { key: "Escape" });

    expect(onCancel).not.toHaveBeenCalled();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
});
