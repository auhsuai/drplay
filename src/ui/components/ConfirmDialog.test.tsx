// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";
import type { ConfirmDialogProps } from "./ConfirmDialog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => (key === "common.close" ? "Close" : key),
  }),
}));

const TITLE = "Use these folders as your root folders?";
const BODY = "You have selected 2 folders.";

afterEach(() => {
  cleanup();
});

function renderDialog(overrides: Partial<ConfirmDialogProps> = {}) {
  const onClose = vi.fn();
  const onConfirm = vi.fn();
  const props: ConfirmDialogProps = {
    isOpen: true,
    title: TITLE,
    body: BODY,
    confirmLabel: "Confirm",
    cancelLabel: "Cancel",
    onClose,
    onConfirm,
    isOperating: false,
    ...overrides,
  };
  const view = render(<ConfirmDialog {...props} />);
  return { ...view, props, onClose, onConfirm };
}

function backdropOf(dialog: HTMLElement): HTMLElement {
  const backdrop = dialog.parentElement;
  if (!backdrop) throw new Error("dialog has no backdrop");
  return backdrop;
}

describe("ConfirmDialog", () => {
  it("renders the title and body", () => {
    renderDialog();

    const dialog = screen.getByRole("dialog", { name: TITLE });
    expect(dialog).toBeTruthy();
    expect(screen.getByText(BODY)).toBeTruthy();
  });

  it("shows the commit error when one is provided", () => {
    renderDialog({ errorMessage: "Couldn't save your root folders." });

    expect(screen.getByRole("alert").textContent).toBe(
      "Couldn't save your root folders.",
    );
  });

  it("moves initial focus to Cancel", () => {
    renderDialog();

    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("calls onConfirm when Confirm is clicked", () => {
    const { onConfirm } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", () => {
    const { onClose } = renderDialog();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on a backdrop click but not on a click inside the dialog", () => {
    const { onClose } = renderDialog();
    const dialog = screen.getByRole("dialog", { name: TITLE });

    fireEvent.click(screen.getByText(BODY));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(backdropOf(dialog));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("disables both actions while operating and ignores Escape and backdrop", () => {
    const { onClose, onConfirm } = renderDialog({ isOperating: true });
    const dialog = screen.getByRole("dialog", { name: TITLE });

    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();

    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(backdropOf(dialog));

    expect(onClose).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("renders nothing while closed", () => {
    renderDialog({ isOpen: false });

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
