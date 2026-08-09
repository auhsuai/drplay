// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RefObject } from "react";
import {
  useTrackMetadata,
  TRACK_METADATA_DEBOUNCE_MS,
} from "./useTrackMetadata";
import type { TrackMetadataOptions } from "./useTrackMetadata";
import { getTrackMetadata } from "../utils/metadata";
import { buildCoverBlobUrl } from "../utils/coverStore";
import type { CachedMetadata } from "../utils/metadata";

vi.mock("../utils/metadata", () => ({
  getTrackMetadata: vi.fn(),
}));

vi.mock("../utils/coverStore", () => ({
  buildCoverBlobUrl: vi.fn(),
}));

const mockedFetch = vi.mocked(getTrackMetadata);
const mockedBuildCover = vi.mocked(buildCoverBlobUrl);

function makeMetadata(overrides: Partial<CachedMetadata> = {}): CachedMetadata {
  return {
    title: "Real Title",
    artist: "Real Artist",
    duration: 0,
    durationEstimated: false,
    pictureData: null,
    pictureDataFull: null,
    v: 8,
    // exactOptionalPropertyTypes forbids an explicit undefined for the
    // optional pictureFormat — only add it when an override provides it.
    ...(overrides.pictureFormat !== undefined
      ? { pictureFormat: overrides.pictureFormat }
      : {}),
    ...overrides,
  };
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderTrackMetadata(options: Partial<TrackMetadataOptions> = {}) {
  // Stable callback identities across re-renders: inline vi.fn()s would change
  // identity on every render and retrigger the effect (they are in the deps).
  const onMetadata = vi.fn();
  const onError = vi.fn();
  const renderResult = renderHook(() =>
    useTrackMetadata({
      fileId: "file-1",
      token: "tok",
      size: 1024,
      originalName: "song.mp3",
      onMetadata,
      onError,
      ...options,
    }),
  );
  return { ...renderResult, onMetadata, onError };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedFetch.mockReset();
  mockedFetch.mockResolvedValue(makeMetadata());
  mockedBuildCover.mockReset();
  mockedBuildCover.mockReturnValue("blob:mock-cover");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useTrackMetadata fetch lifecycle", () => {
  it("fetches with id/token/size/name + AbortSignal and calls onMetadata with the resolved entry", async () => {
    const { onMetadata } = renderTrackMetadata();
    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledTimes(1);
    });
    expect(mockedFetch).toHaveBeenCalledWith(
      "file-1",
      "tok",
      1024,
      "song.mp3",
      expect.any(AbortSignal),
    );
    expect(onMetadata).toHaveBeenCalledTimes(1);
    expect(onMetadata.mock.calls[0]?.[0]).toMatchObject({
      title: "Real Title",
    });
  });

  it("passes undefined token through when token is null (NowPlaying fetch-without-token path)", async () => {
    renderTrackMetadata({ token: null });
    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledTimes(1);
    });
    expect(mockedFetch).toHaveBeenCalledWith(
      "file-1",
      undefined,
      1024,
      "song.mp3",
      expect.any(AbortSignal),
    );
  });

  it("guards on enabled=false: no fetch, no callbacks", async () => {
    const { onMetadata, onError } = renderTrackMetadata({ enabled: false });
    await flushMicrotasks();
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(onMetadata).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("re-fetches when refreshKey changes (consumer extra dep)", async () => {
    const { result, rerender } = renderHook(
      ({ refreshKey }: { refreshKey: number }) =>
        useTrackMetadata({
          fileId: "file-1",
          token: "tok",
          refreshKey,
          onMetadata: vi.fn(),
          onError: vi.fn(),
        }),
      { initialProps: { refreshKey: 1 } },
    );
    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledTimes(1);
    });
    rerender({ refreshKey: 2 });
    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledTimes(2);
    });
    expect(result.current.coverUrl).toBeNull();
  });
});

describe("useTrackMetadata debounce", () => {
  it("debounces: no fetch before the window elapses, exactly one after", async () => {
    vi.useFakeTimers();
    renderTrackMetadata({ debounceMs: TRACK_METADATA_DEBOUNCE_MS });
    await flushMicrotasks();
    expect(mockedFetch).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(TRACK_METADATA_DEBOUNCE_MS - 1);
      await Promise.resolve();
    });
    expect(mockedFetch).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });
});

describe("useTrackMetadata metadata-updated listener", () => {
  it("re-fetches on metadata-updated for the matching fileId", async () => {
    renderTrackMetadata({ listenMetadataUpdated: true });
    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledTimes(1);
    });
    window.dispatchEvent(
      new CustomEvent("metadata-updated", { detail: { fileId: "file-1" } }),
    );
    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledTimes(2);
    });
  });

  it("ignores metadata-updated for a different fileId", async () => {
    renderTrackMetadata({ listenMetadataUpdated: true });
    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledTimes(1);
    });
    window.dispatchEvent(
      new CustomEvent("metadata-updated", { detail: { fileId: "other" } }),
    );
    await flushMicrotasks();
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("does not listen for metadata-updated by default", async () => {
    renderTrackMetadata();
    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledTimes(1);
    });
    window.dispatchEvent(
      new CustomEvent("metadata-updated", { detail: { fileId: "file-1" } }),
    );
    await flushMicrotasks();
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("removes the metadata-updated listener on unmount", async () => {
    const { unmount } = renderTrackMetadata({ listenMetadataUpdated: true });
    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledTimes(1);
    });
    unmount();
    window.dispatchEvent(
      new CustomEvent("metadata-updated", { detail: { fileId: "file-1" } }),
    );
    await flushMicrotasks();
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });
});

describe("useTrackMetadata cover blob URL", () => {
  it("builds the cover from pictureDataFull (full preferred) and sets coverUrl", async () => {
    mockedFetch.mockResolvedValue(
      makeMetadata({
        pictureData: new Uint8Array([1]),
        pictureDataFull: new Uint8Array([1, 2, 3]),
        pictureFormat: "image/jpeg",
      }),
    );
    const { result, onMetadata } = renderTrackMetadata();
    await waitFor(() => {
      expect(result.current.coverUrl).toBe("blob:mock-cover");
    });
    expect(mockedBuildCover).toHaveBeenCalledWith(
      new Uint8Array([1, 2, 3]),
      "image/jpeg",
    );
    expect(onMetadata.mock.calls[0]?.[1]).toBe("blob:mock-cover");
  });

  it("falls back to thumb bytes when pictureDataFull is null", async () => {
    mockedFetch.mockResolvedValue(
      makeMetadata({
        pictureData: new Uint8Array([9]),
        pictureFormat: "image/png",
      }),
    );
    const { result } = renderTrackMetadata();
    await waitFor(() => {
      expect(result.current.coverUrl).toBe("blob:mock-cover");
    });
    expect(mockedBuildCover).toHaveBeenCalledWith(
      new Uint8Array([9]),
      "image/png",
    );
  });

  it("keeps coverUrl null when there are no picture bytes (icon path)", async () => {
    const { result, onMetadata } = renderTrackMetadata();
    await waitFor(() => {
      expect(onMetadata).toHaveBeenCalledTimes(1);
    });
    expect(result.current.coverUrl).toBeNull();
    expect(mockedBuildCover).not.toHaveBeenCalled();
    expect(onMetadata.mock.calls[0]?.[1]).toBeNull();
  });

  it("exposes setCoverUrl so callers can clear the cover on img error", async () => {
    mockedFetch.mockResolvedValue(
      makeMetadata({ pictureData: new Uint8Array([1]) }),
    );
    const { result } = renderTrackMetadata();
    await waitFor(() => {
      expect(result.current.coverUrl).toBe("blob:mock-cover");
    });
    act(() => {
      result.current.setCoverUrl(null);
    });
    expect(result.current.coverUrl).toBeNull();
  });
});

describe("useTrackMetadata abort / error handling", () => {
  it("skips onMetadata when the fetch resolves after unmount (cleanup abort)", async () => {
    let resolveFetch!: (value: CachedMetadata) => void;
    mockedFetch.mockReturnValue(
      new Promise<CachedMetadata>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const { unmount, onMetadata, onError } = renderTrackMetadata();
    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledTimes(1);
    });
    unmount();
    await act(async () => {
      resolveFetch(makeMetadata());
      await Promise.resolve();
    });
    expect(onMetadata).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("skips onError when the fetch rejects after unmount (deliberate cleanup abort)", async () => {
    let rejectFetch!: (reason: unknown) => void;
    mockedFetch.mockReturnValue(
      new Promise<CachedMetadata>((_, reject) => {
        rejectFetch = reject;
      }),
    );
    const { unmount, onError, result } = renderTrackMetadata();
    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledTimes(1);
    });
    unmount();
    await act(async () => {
      rejectFetch(new Error("aborted"));
      await Promise.resolve();
    });
    expect(onError).not.toHaveBeenCalled();
    expect(result.current.coverUrl).toBeNull();
  });

  it("skips onError when the fetch rejects with DOMException AbortError while mounted", async () => {
    mockedFetch.mockRejectedValue(new DOMException("Aborted", "AbortError"));
    const { onError } = renderTrackMetadata();
    await flushMicrotasks();
    expect(onError).not.toHaveBeenCalled();
  });

  it("calls onError with the failure when the fetch rejects while mounted", async () => {
    mockedFetch.mockRejectedValue(new Error("boom"));
    const { onError, result } = renderTrackMetadata();
    await waitFor(() => {
      expect(onError).toHaveBeenCalledTimes(1);
    });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "boom" }),
    );
    expect(result.current.coverUrl).toBeNull();
  });

  it("passes a signal to onMetadata that reads aborted after unmount (palette guard support)", async () => {
    const { unmount, onMetadata } = renderTrackMetadata();
    await waitFor(() => {
      expect(onMetadata).toHaveBeenCalledTimes(1);
    });
    const signal = onMetadata.mock.calls[0]?.[2] as AbortSignal;
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
  });
});

describe("useTrackMetadata img cleanup", () => {
  it("clears the captured img src on unmount (ref captured at setup)", async () => {
    const img = document.createElement("img");
    const imgRef: RefObject<HTMLImageElement | null> = { current: img };
    const { unmount } = renderTrackMetadata({ imgRef });
    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledTimes(1);
    });
    unmount();
    // jsdom resolves the empty src property to the document base URL — the
    // attribute keeps the raw value the cleanup assigned.
    expect(img.getAttribute("src")).toBe("");
  });

  it("runs onCleanup on every cleanup (consumer state the hook cannot reach)", async () => {
    const onCleanup = vi.fn();
    const { unmount } = renderTrackMetadata({ onCleanup });
    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledTimes(1);
    });
    unmount();
    expect(onCleanup).toHaveBeenCalledTimes(1);
  });
});
