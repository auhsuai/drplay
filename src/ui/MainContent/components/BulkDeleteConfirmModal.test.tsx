// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { BulkDeleteConfirmModal } from "./BulkDeleteConfirmModal";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

// Contract under test (F4 ModalShell migration): the confirm dialog must be a
// labelled WAI-ARIA APG dialog, and every dismissal path (Escape, backdrop
// click) must be blocked while the bulk delete is operating.
describe("BulkDeleteConfirmModal WAI-ARIA APG dialog semantics", () => {
  afterEach(() => {
    cleanup();
  });

  function renderModal(
    over: Partial<Parameters<typeof BulkDeleteConfirmModal>[0]> = {},
  ) {
    const props = {
      isOpen: true,
      onClose: vi.fn(),
      onConfirm: vi.fn(),
      isOperating: false,
      selectedCount: 3,
      ...over,
    };
    const view = render(<BulkDeleteConfirmModal {...props} />);
    return { ...view, props };
  }

  function required(el: Element | null): HTMLElement {
    if (!(el instanceof HTMLElement)) throw new Error("expected element");
    return el;
  }

  it('exposes role="dialog" aria-modal="true" aria-labelledby pointing to visible title', () => {
    const { container } = renderModal();
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(dialog?.getAttribute("aria-labelledby")).toBe("bulk-delete-title");
    expect(container.querySelector("#bulk-delete-title")).not.toBeNull();
  });

  it("closes on Escape keydown while idle", () => {
    const { props } = renderModal({ isOperating: false });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the dialog open on Escape while the delete is operating", () => {
    const { props } = renderModal({ isOperating: true });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("closes on backdrop click while idle", () => {
    const { container, props } = renderModal({ isOperating: false });
    fireEvent.click(required(container.querySelector('[role="presentation"]')));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores backdrop clicks while the delete is operating", () => {
    const { container, props } = renderModal({ isOperating: true });
    fireEvent.click(required(container.querySelector('[role="presentation"]')));
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("ignores clicks on the dialog body (only the backdrop closes)", () => {
    const { container, props } = renderModal({ isOperating: false });
    fireEvent.click(required(container.querySelector("#bulk-delete-title")));
    expect(props.onClose).not.toHaveBeenCalled();
  });
});
