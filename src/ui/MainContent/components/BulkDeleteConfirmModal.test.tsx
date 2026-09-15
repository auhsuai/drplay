// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { BulkDeleteConfirmModal } from "./BulkDeleteConfirmModal";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => {
          setOpen(true);
        }}
      >
        open-bulk-delete
      </button>
      <BulkDeleteConfirmModal
        isOpen={open}
        onClose={() => {
          setOpen(false);
        }}
        onConfirm={vi.fn()}
        isOperating={false}
        selectedCount={2}
      />
    </>
  );
}

describe("BulkDeleteConfirmModal APG dialog semantics (P2-04-3)", () => {
  afterEach(() => {
    cleanup();
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });

  it("exposes role=dialog with aria-modal, labelled title and a named close button", () => {
    render(
      <BulkDeleteConfirmModal
        isOpen
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        isOperating={false}
        selectedCount={2}
      />,
    );
    const dialog = screen.getByRole("dialog", {
      name: "drive.bulk_delete_title",
    });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByRole("button", { name: "common.close" })).toBeTruthy();
  });

  it("moves initial focus to the least destructive control (Cancel), never Delete", () => {
    render(
      <BulkDeleteConfirmModal
        isOpen
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        isOperating={false}
        selectedCount={2}
      />,
    );
    expect(document.activeElement).toBe(screen.getByText("menu.cancel"));
    expect(document.activeElement).not.toBe(screen.getByText("drive.delete"));
  });

  it("moves focus into the dialog on open and back to the invoker on close", () => {
    render(<Harness />);
    const opener = screen.getByText("open-bulk-delete");
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(screen.getByText("menu.cancel"));

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByText("drive.bulk_delete_title")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
