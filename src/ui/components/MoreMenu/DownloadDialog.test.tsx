// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import type { TFunction } from "i18next";
import { DownloadDialog } from "./DownloadDialog";

// Same minimal TFunction stub as useMenuDelete.test.ts / PlaylistsSubmenu.test.tsx.
const t = ((key: string) => key) as unknown as TFunction;

function baseProps(over: Partial<Parameters<typeof DownloadDialog>[0]> = {}) {
  return {
    show: true,
    isDownloadingFile: false,
    downloadFileName: "song.mp3",
    setDownloadFileName: vi.fn(),
    onClose: vi.fn(),
    onConfirm: vi.fn(),
    t,
    ...over,
  };
}

describe("DownloadDialog Escape-to-cancel (slice A)", () => {
  afterEach(() => {
    cleanup();
  });

  it("Esc while shown and not downloading calls onClose once", () => {
    const onClose = vi.fn();
    render(<DownloadDialog {...baseProps({ onClose })} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Esc while downloading is ignored (same guard as X/Cancel buttons)", () => {
    const onClose = vi.fn();
    render(
      <DownloadDialog {...baseProps({ onClose, isDownloadingFile: true })} />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Esc while hidden is a no-op (no listener when show is false)", () => {
    const onClose = vi.fn();
    render(<DownloadDialog {...baseProps({ onClose, show: false })} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("non-Escape keys do not close", () => {
    const onClose = vi.fn();
    render(<DownloadDialog {...baseProps({ onClose })} />);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("unmount removes the keydown listener", () => {
    const onClose = vi.fn();
    const { unmount } = render(<DownloadDialog {...baseProps({ onClose })} />);
    unmount();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
