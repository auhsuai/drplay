// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
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
