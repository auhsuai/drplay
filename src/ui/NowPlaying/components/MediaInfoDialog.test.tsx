// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MpvTrack } from "../../../lib/mpvControl";

const mediaMock = vi.hoisted(() => ({ getMediaInfo: vi.fn() }));
vi.mock("../../../lib/mpvControl", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../lib/mpvControl")>();
  return { ...actual, getMediaInfo: mediaMock.getMediaInfo };
});

import { MediaInfoDialog } from "./MediaInfoDialog";

function mpvTrack(overrides: Partial<MpvTrack> = {}): MpvTrack {
  return {
    id: 1,
    type: "audio",
    isDefault: false,
    forced: false,
    selected: false,
    external: false,
    ...overrides,
  };
}

function makeInfo(overrides: Record<string, unknown> = {}) {
  return {
    path: "C:\\videos\\movie.mkv",
    title: "Movie",
    duration: 200,
    videoCodec: "h264",
    width: 1920,
    height: 1080,
    fps: 23.976,
    pixelFormat: "yuv420p",
    audioCodec: "aac",
    hwdec: "d3d11va",
    videoOutput: "gpu-next",
    videoBitrate: 5_000_000,
    audioBitrate: 128_000,
    audioTracks: [
      mpvTrack({
        id: 1,
        title: "English",
        lang: "en",
        channels: 2,
        selected: true,
      }),
    ],
    subtitleTracks: [mpvTrack({ id: 7, type: "sub", title: "Vietnamese" })],
    audioTrackId: 1,
    subtitleTrackId: null,
    ...overrides,
  };
}

beforeEach(() => {
  mediaMock.getMediaInfo.mockReset();
  mediaMock.getMediaInfo.mockResolvedValue(makeInfo());
});

afterEach(() => {
  cleanup();
});

describe("MediaInfoDialog — data rendering", () => {
  it("renders file, duration, video, audio, hwdec, output, bitrate and tracks", async () => {
    render(<MediaInfoDialog open onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId("media-info-file").textContent).toBe(
        "C:\\videos\\movie.mkv",
      );
    });
    expect(screen.getByTestId("media-info-duration").textContent).toBe("3:20");
    expect(screen.getByTestId("media-info-video").textContent).toContain(
      "h264",
    );
    expect(screen.getByTestId("media-info-video").textContent).toContain(
      "1920×1080",
    );
    expect(screen.getByTestId("media-info-video").textContent).toContain(
      "23.98 fps",
    );
    expect(screen.getByTestId("media-info-video").textContent).toContain(
      "yuv420p",
    );
    expect(screen.getByTestId("media-info-audio").textContent).toContain("aac");
    expect(screen.getByTestId("media-info-audio").textContent).toContain(
      "2 ch",
    );
    expect(screen.getByTestId("media-info-hwdec").textContent).toBe("d3d11va");
    expect(screen.getByTestId("media-info-output").textContent).toBe(
      "gpu-next",
    );
    expect(screen.getByTestId("media-info-bitrate").textContent).toBe(
      "5.00 Mbps",
    );
    // Selected audio track carries the marker; the unselected sub track does not.
    expect(screen.getByTestId("media-info-tracks").textContent).toContain(
      "✓ English — en",
    );
    expect(screen.getByTestId("media-info-tracks").textContent).toContain(
      "Vietnamese",
    );
  });

  it("shows an em dash for every missing field", async () => {
    mediaMock.getMediaInfo.mockResolvedValue(
      makeInfo({
        path: null,
        title: null,
        duration: null,
        videoCodec: null,
        width: null,
        height: null,
        fps: null,
        pixelFormat: null,
        audioCodec: null,
        hwdec: null,
        videoOutput: null,
        videoBitrate: null,
        audioBitrate: null,
        audioTracks: [],
        subtitleTracks: [],
      }),
    );

    render(<MediaInfoDialog open onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId("media-info-file").textContent).toBe("—");
    });
    expect(screen.getByTestId("media-info-duration").textContent).toBe("—");
    expect(screen.getByTestId("media-info-video").textContent).toBe("—");
    expect(screen.getByTestId("media-info-audio").textContent).toBe("—");
    expect(screen.getByTestId("media-info-hwdec").textContent).toBe("—");
    expect(screen.getByTestId("media-info-output").textContent).toBe("—");
    expect(screen.getByTestId("media-info-bitrate").textContent).toBe("—");
    expect(screen.getByTestId("media-info-tracks").textContent).toBe("—");
  });

  it("a failing getMediaInfo shows the error inside the dialog, never crashes", async () => {
    mediaMock.getMediaInfo.mockRejectedValue(
      new Error("mpvControl get failed: boom"),
    );

    render(<MediaInfoDialog open onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId("media-info-error").textContent).toContain(
        "boom",
      );
    });
    expect(screen.queryByTestId("media-info-file")).toBeNull();
  });

  it("reloads the data every time it opens", async () => {
    const { rerender } = render(<MediaInfoDialog open onClose={vi.fn()} />);
    await waitFor(() => {
      expect(mediaMock.getMediaInfo).toHaveBeenCalledTimes(1);
    });

    rerender(<MediaInfoDialog open={false} onClose={vi.fn()} />);
    rerender(<MediaInfoDialog open onClose={vi.fn()} />);
    await waitFor(() => {
      expect(mediaMock.getMediaInfo).toHaveBeenCalledTimes(2);
    });
  });

  it("renders nothing while closed", () => {
    const { container } = render(
      <MediaInfoDialog open={false} onClose={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
    expect(mediaMock.getMediaInfo).not.toHaveBeenCalled();
  });
});

describe("MediaInfoDialog — closing", () => {
  it("Escape closes the dialog and stops the event before the overlay's handler", async () => {
    const onClose = vi.fn();
    render(<MediaInfoDialog open onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy();
    });

    // Bubble-phase listener = the layer behind the dialog (useNowPlayingShortcuts
    // listens on window without capture). The dialog must win.
    const behind = vi.fn();
    window.addEventListener("keydown", behind);
    fireEvent.keyDown(document.body, { key: "Escape" });
    window.removeEventListener("keydown", behind);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(behind).not.toHaveBeenCalled();
  });

  it("non-Escape keys are left alone", async () => {
    const onClose = vi.fn();
    render(<MediaInfoDialog open onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeTruthy();
    });

    fireEvent.keyDown(document.body, { key: "f" });

    expect(onClose).not.toHaveBeenCalled();
  });
});
