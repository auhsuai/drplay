// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { useState } from "react";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  act,
} from "@testing-library/react";
import { NewFolderModal } from "./NewFolderModal";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../../utils/simpleToast", () => ({
  showErrorToast: vi.fn(),
}));

function baseProps(over: Partial<Parameters<typeof NewFolderModal>[0]> = {}) {
  return {
    isOpen: true,
    onClose: vi.fn(),
    onCreate: vi.fn(),
    isCreating: false,
    ...over,
  };
}

describe("NewFolderModal Escape-to-cancel (slice A)", () => {
  afterEach(() => {
    cleanup();
  });

  it("Esc while open and not creating calls onClose once", () => {
    const onClose = vi.fn();
    render(<NewFolderModal {...baseProps({ onClose })} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Esc while creating is ignored (same guard as backdrop click)", () => {
    const onClose = vi.fn();
    render(<NewFolderModal {...baseProps({ onClose, isCreating: true })} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Esc while closed is a no-op (no listener when isOpen is false)", () => {
    const onClose = vi.fn();
    render(<NewFolderModal {...baseProps({ onClose, isOpen: false })} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("non-Escape keys do not close", () => {
    const onClose = vi.fn();
    render(<NewFolderModal {...baseProps({ onClose })} />);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("unmount removes the keydown listener", () => {
    const onClose = vi.fn();
    const { unmount } = render(<NewFolderModal {...baseProps({ onClose })} />);
    unmount();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("NewFolderModal name preservation + reopen reset (P2-04-1)", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps the typed name when the parent never closes the modal (create failure)", async () => {
    // Parent keeps the modal open on failure (useDriveBulkOps retry contract):
    // the typed name must survive so the user can retry.
    const onCreate = vi.fn();
    render(<NewFolderModal {...baseProps({ onCreate })} />);
    const input: HTMLInputElement = screen.getByPlaceholderText(
      "drive.folder_name_placeholder",
    );
    fireEvent.change(input, { target: { value: "My Folder" } });
    fireEvent.click(screen.getByText("menu.create"));
    await act(async () => {}); // flush the submit microtasks
    expect(onCreate).toHaveBeenCalledWith("My Folder");
    expect(input.value).toBe("My Folder");
  });

  it("starts clean every time it is reopened", () => {
    const props = baseProps();
    const { rerender } = render(<NewFolderModal {...props} />);
    fireEvent.change(
      screen.getByPlaceholderText("drive.folder_name_placeholder"),
      {
        target: { value: "abc" },
      },
    );
    rerender(<NewFolderModal {...props} isOpen={false} />);
    rerender(<NewFolderModal {...props} isOpen={true} />);
    const reopened: HTMLInputElement = screen.getByPlaceholderText(
      "drive.folder_name_placeholder",
    );
    expect(reopened.value).toBe("");
  });
});

describe("NewFolderModal Escape layering (P2-04-2)", () => {
  afterEach(() => {
    cleanup();
  });

  it("Esc inside the modal does not reach a background window-bubble listener (QueuePanel layer)", () => {
    // QueuePanel registers a plain window keydown listener; the modal must
    // swallow the press (capture + stopPropagation) so one Esc closes only
    // the modal.
    const background = vi.fn();
    window.addEventListener("keydown", background);
    try {
      const onClose = vi.fn();
      render(<NewFolderModal {...baseProps({ onClose })} />);
      const input = screen.getByPlaceholderText(
        "drive.folder_name_placeholder",
      );
      input.focus();
      fireEvent.keyDown(input, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(background).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", background);
    }
  });
});

describe("NewFolderModal APG dialog semantics (P2-04-4)", () => {
  afterEach(() => {
    cleanup();
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });

  it("exposes role=dialog with aria-modal and the title as accessible name", () => {
    render(<NewFolderModal {...baseProps()} />);
    const dialog = screen.getByRole("dialog", {
      name: "drive.new_folder_title",
    });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });

  it("labels the name input and the close button", () => {
    render(<NewFolderModal {...baseProps()} />);
    expect(screen.getByLabelText("drive.folder_name_placeholder")).toBeTruthy();
    expect(screen.getByRole("button", { name: "common.close" })).toBeTruthy();
  });

  it("moves focus into the dialog on open and back to the invoker on close", () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button
            onClick={() => {
              setOpen(true);
            }}
          >
            open-folder-modal
          </button>
          <NewFolderModal
            isOpen={open}
            onClose={() => {
              setOpen(false);
            }}
            onCreate={vi.fn()}
            isCreating={false}
          />
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByText("open-folder-modal");
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(
      screen.getByPlaceholderText("drive.folder_name_placeholder"),
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
