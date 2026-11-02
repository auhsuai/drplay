// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RefObject } from "react";
import type { DriveItem } from "../../../types";
import type { CachedMetadata } from "../../../utils/metadata";
import { useSongCardMetadata } from "./useSongCardMetadata";
import { getTrackMetadata } from "../../../utils/metadata";

vi.mock("../../../utils/metadata", () => ({
  getTrackMetadata: vi.fn(),
}));

vi.mock("../../../utils/coverStore", () => ({
  buildCoverBlobUrl: vi.fn(() => "blob:cover"),
  buildCoverUrl: vi.fn(() => "drplay:cover"),
  revokeCoverBlobUrl: vi.fn(),
}));

vi.mock("../../../utils/errorLog", () => ({
  captureError: vi.fn(() => undefined),
}));

const mockedFetch = vi.mocked(getTrackMetadata);

function makeItem(overrides: Partial<DriveItem> = {}): DriveItem {
  return {
    id: "song-1",
    name: "song.mp3",
    mimeType: "audio/mpeg",
    trackInfo: { size: 2048, originalName: "song.mp3" },
    ...overrides,
  } as DriveItem;
}

function realMetadata(overrides: Partial<CachedMetadata> = {}): CachedMetadata {
  return {
    title: "Real Title",
    artist: "Real Artist",
    duration: 120,
    durationEstimated: false,
    pictureData: null,
    pictureDataFull: null,
    v: 8,
    outcome: "success",
    ...overrides,
  };
}

function placeholder(overrides: Partial<CachedMetadata> = {}): CachedMetadata {
  return {
    title: "song",
    artist: "Unknown Artist",
    duration: 0,
    durationEstimated: true,
    pictureData: null,
    pictureDataFull: null,
    v: 9,
    ...overrides,
  };
}

const imgRef: RefObject<HTMLImageElement | null> = { current: null };

beforeEach(() => {
  vi.clearAllMocks();
  mockedFetch.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useSongCardMetadata placeholder lifecycle", () => {
  it("marks a REAL entry as loaded", async () => {
    mockedFetch.mockResolvedValue(realMetadata());
    const { result } = renderHook(() =>
      useSongCardMetadata({ item: makeItem(), token: "tok", imgRef }),
    );
    await waitFor(() => {
      expect(result.current.meta.loaded).toBe(true);
    });
    expect(result.current.meta.duration).toBe(120);
    expect(result.current.meta.outcome).toBe("success");
  });

  it("does NOT mark a transient-failure placeholder as loaded", async () => {
    mockedFetch.mockResolvedValue(
      placeholder({ outcome: "transient_failure", provisional: true }),
    );
    const { result } = renderHook(() =>
      useSongCardMetadata({ item: makeItem(), token: "tok", imgRef }),
    );
    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.meta.loaded).toBe(false);
    expect(result.current.meta.outcome).toBe("transient_failure");
    // Still renders the filename-derived artist so the card is not blank.
    expect(result.current.meta.artist).toBe("Unknown Artist");
  });

  it("does NOT mark a circuit_open placeholder as loaded", async () => {
    mockedFetch.mockResolvedValue(
      placeholder({ outcome: "circuit_open", provisional: true }),
    );
    const { result } = renderHook(() =>
      useSongCardMetadata({ item: makeItem(), token: "tok", imgRef }),
    );
    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.meta.loaded).toBe(false);
    expect(result.current.meta.outcome).toBe("circuit_open");
  });

  it("does NOT mark a deterministic unsupported placeholder as loaded", async () => {
    mockedFetch.mockResolvedValue(
      placeholder({ outcome: "unsupported", provisional: false }),
    );
    const { result } = renderHook(() =>
      useSongCardMetadata({ item: makeItem(), token: "tok", imgRef }),
    );
    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.meta.loaded).toBe(false);
    expect(result.current.meta.outcome).toBe("unsupported");
  });

  it("exposes retry() and never fetches for a folder or a token-less card", async () => {
    const folder = renderHook(() =>
      useSongCardMetadata({
        item: makeItem({ isFolder: true }),
        token: "tok",
        imgRef,
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(typeof folder.result.current.retry).toBe("function");
    cleanup();

    renderHook(() =>
      useSongCardMetadata({ item: makeItem(), token: null, imgRef }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockedFetch).not.toHaveBeenCalled();
    cleanup();
  });

  it("retry() re-runs the fetch for the same mount", async () => {
    mockedFetch.mockResolvedValue(placeholder({ outcome: "unsupported" }));
    const { result } = renderHook(() =>
      useSongCardMetadata({ item: makeItem(), token: "tok", imgRef }),
    );
    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledTimes(1);
    });
    act(() => {
      result.current.retry();
    });
    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledTimes(2);
    });
  });
});
