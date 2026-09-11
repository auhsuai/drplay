// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import type { TFunction } from "i18next";
import { DeleteConfirmDialog } from "./DeleteConfirmDialog";

// Same minimal TFunction stub as useMenuDelete.test.ts / PlaylistsSubmenu.test.tsx.
const t = ((key: string) => key) as unknown as TFunction;

function baseProps(
  over: Partial<Parameters<typeof DeleteConfirmDialog>[0]> = {},
) {
  return {
    show: true,
    isDeleting: false,
    driveItem: null,
    onClose: vi.fn(),
    onConfirm: vi.fn(),
    t,
    ...over,
  };
}

describe("DeleteConfirmDialog Escape-to-cancel (slice A)", () => {
  afterEach(() => {
    cleanup();
  });

  it("Esc while shown and not deleting calls onClose once", () => {
    const onClose = vi.fn();
    render(<DeleteConfirmDialog {...baseProps({ onClose })} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Esc while deleting is ignored (same guard as backdrop click)", () => {
    const onClose = vi.fn();
    render(
      <DeleteConfirmDialog {...baseProps({ onClose, isDeleting: true })} />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Esc while hidden is a no-op (no listener when show is false)", () => {
    const onClose = vi.fn();
    render(<DeleteConfirmDialog {...baseProps({ onClose, show: false })} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("non-Escape keys do not close", () => {
    const onClose = vi.fn();
    render(<DeleteConfirmDialog {...baseProps({ onClose })} />);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("unmount removes the keydown listener", () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <DeleteConfirmDialog {...baseProps({ onClose })} />,
    );
    unmount();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
