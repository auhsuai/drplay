// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup, screen } from "@testing-library/react";
import type { TFunction } from "i18next";
import { DownloadDialog } from "./DownloadDialog";

// Same minimal TFunction stub as useMenuDelete.test.ts / PlaylistsSubmenu.test.tsx.
const t = ((key: string) => key) as unknown as TFunction;

function baseProps(over: Partial<Parameters<typeof DownloadDialog>[0]> = {}) {
  return {
    show: true,
    isDownloadingFile: false,
    downloadFileName: "song.mp3",
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

describe("DownloadDialog dialog semantics + focus (P2-09b-5/-6/-7)", () => {
  afterEach(() => {
    cleanup();
  });

  it("exposes role=dialog, aria-modal and a labelled-by title", () => {
    render(<DownloadDialog {...baseProps()} />);

    const dialog = screen.getByRole("dialog", {
      name: "menu.download_title",
    });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe("download-title");
  });

  // No rename field anymore: the dialog shows the file name read-only
  // and the file count (1 file) instead of an editable name.
  it("shows the file name as read-only text with the 1-file count, and no textbox", () => {
    render(<DownloadDialog {...baseProps()} />);

    expect(screen.getByText("song.mp3")).toBeInTheDocument();
    // Identity t stub: the plural key itself, resolved by i18next at
    // runtime to "1 file" / "1 tệp".
    expect(screen.getByText("menu.download_panel_files")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("focuses the dialog itself on open (the rename input is gone)", () => {
    render(<DownloadDialog {...baseProps()} />);

    expect(document.activeElement).toBe(
      screen.getByRole("dialog", { name: "menu.download_title" }),
    );
  });

  it("returns focus to the invoker when it closes", () => {
    const invoker = document.createElement("button");
    document.body.appendChild(invoker);
    invoker.focus();

    const { rerender } = render(<DownloadDialog {...baseProps()} />);
    expect(document.activeElement).not.toBe(invoker);

    rerender(<DownloadDialog {...baseProps({ show: false })} />);

    expect(document.activeElement).toBe(invoker);
    invoker.remove();
  });
});

describe("DownloadDialog progress (streaming download)", () => {
  afterEach(() => {
    cleanup();
  });

  function progressProps(
    over: Partial<Parameters<typeof DownloadDialog>[0]> = {},
  ) {
    return baseProps({
      isDownloadingFile: true,
      downloadProgress: {
        downloaded: 512,
        total: 1024,
        percent: 50,
        speedBytesPerSec: 256,
        stage: "downloading",
        paused: false,
      },
      onCancelDownload: vi.fn(),
      onPauseDownload: vi.fn(),
      onResumeDownload: vi.fn(),
      ...over,
    });
  }

  it("shows the percent and downloaded/total while downloading", () => {
    render(<DownloadDialog {...progressProps()} />);

    expect(screen.getByText("50%")).toBeInTheDocument();
    // 512 B / 1 KB via formatBytes, plus the speed in the same line.
    expect(screen.getByText("512 B / 1 KB · 256 B/s")).toBeInTheDocument();
  });

  it("shows the transfer speed while downloading", () => {
    render(<DownloadDialog {...progressProps()} />);

    expect(screen.getByText("512 B / 1 KB · 256 B/s")).toBeInTheDocument();
  });

  it("shows only the downloaded bytes when the total is unknown", () => {
    render(
      <DownloadDialog
        {...progressProps({
          downloadProgress: {
            downloaded: 512,
            total: undefined,
            percent: undefined,
            speedBytesPerSec: undefined,
            stage: "downloading",
            paused: false,
          },
        })}
      />,
    );

    // Percent unknown: both the header (no percent) and the footer show
    // the downloaded bytes only — two "512 B" texts, no "%" anywhere.
    expect(screen.getAllByText("512 B")).toHaveLength(2);
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it("shows the verifying stage instead of the percent", () => {
    render(
      <DownloadDialog
        {...progressProps({
          downloadProgress: {
            downloaded: 1024,
            total: 1024,
            percent: 100,
            speedBytesPerSec: undefined,
            stage: "verifying",
            paused: false,
          },
        })}
      />,
    );

    expect(screen.getByText("menu.download_verifying")).toBeInTheDocument();
  });

  it("Pause calls onPauseDownload, Cancel calls onCancelDownload", () => {
    const onPauseDownload = vi.fn();
    const onCancelDownload = vi.fn();
    render(
      <DownloadDialog
        {...progressProps({ onPauseDownload, onCancelDownload })}
      />,
    );

    fireEvent.click(screen.getByText("menu.download_pause"));
    expect(onPauseDownload).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("menu.cancel"));
    expect(onCancelDownload).toHaveBeenCalledTimes(1);
  });

  it("shows Resume (not Pause) while paused and calls onResumeDownload", () => {
    const onResumeDownload = vi.fn();
    render(
      <DownloadDialog
        {...progressProps({
          downloadPaused: true,
          downloadProgress: {
            downloaded: 512,
            total: 1024,
            percent: 50,
            speedBytesPerSec: undefined,
            stage: "downloading",
            paused: true,
          },
          onResumeDownload,
        })}
      />,
    );

    expect(screen.getByText("menu.download_paused")).toBeInTheDocument();
    fireEvent.click(screen.getByText("menu.download_resume"));
    expect(onResumeDownload).toHaveBeenCalledTimes(1);
  });

  it("does not show a progress bar before the download starts", () => {
    render(<DownloadDialog {...baseProps()} />);

    expect(screen.queryByRole("status")).toBeNull();
  });
});
