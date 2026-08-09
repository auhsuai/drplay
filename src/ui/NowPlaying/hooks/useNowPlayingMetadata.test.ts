// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { MockInstance } from "vitest";
import type { Track } from "../../../types";
import type { CachedMetadata } from "../../../utils/metadata";
import { getTrackMetadata } from "../../../utils/metadata";
import { getPalette } from "../../../utils/color";
import { captureError } from "../../../utils/errorLog";
import { useNowPlayingMetadata } from "./useNowPlayingMetadata";

vi.mock("../../../utils/metadata", () => ({
  getTrackMetadata: vi.fn(),
}));

vi.mock("../../../utils/color", () => ({
  getPalette: vi.fn(),
}));

vi.mock("../../../utils/errorLog", () => ({
  captureError: vi.fn(),
}));

const mockedGetTrackMetadata = vi.mocked(getTrackMetadata);
const mockedGetPalette = vi.mocked(getPalette);
const mockedCaptureError = vi.mocked(captureError);

const BLOB_URL = "blob:mock-nowplaying-cover";

// jsdom does NOT implement URL.createObjectURL / revokeObjectURL (both are
// undefined at runtime) — install observable spies once so the hook's blob URL
// lifecycle can be asserted.
beforeAll(() => {
  if (typeof URL.createObjectURL !== "function") {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
  }
  if (typeof URL.revokeObjectURL !== "function") {
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
  }
});

let createObjectURLSpy: MockInstance<(obj: Blob | MediaSource) => string>;
let revokeObjectURLSpy: MockInstance<(url: string) => void>;

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: "file-123",
    title: "Test Song",
    artist: "Test Artist",
    streamUrl: "https://example.com/test-song",
    originalName: "test-song.mp3",
    ...overrides,
  };
}

function metadataWithPicture(): CachedMetadata {
  return {
    title: "Real Title",
    artist: "Real Artist",
    duration: 0,
    durationEstimated: false,
    pictureData: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    pictureDataFull: null,
    pictureFormat: "image/png",
    v: 10,
  };
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reset once-implementations too: a mockResolvedValueOnce left unconsumed
  // by one test would leak into the next (clearAllMocks keeps them).
  mockedGetTrackMetadata.mockReset();
  mockedGetPalette.mockReset();
  createObjectURLSpy = vi
    .spyOn(URL, "createObjectURL")
    .mockReturnValue(BLOB_URL);
  revokeObjectURLSpy = vi
    .spyOn(URL, "revokeObjectURL")
    .mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useNowPlayingMetadata blob cover URL (picture bytes, no drplay://)", () => {
  function metadataWithFullPicture(): CachedMetadata {
    return {
      ...metadataWithPicture(),
      pictureDataFull: new Uint8Array([9, 9, 9, 9]),
    };
  }

  it("builds the cover from the full picture bytes and passes the blob URL to getPalette", async () => {
    mockedGetTrackMetadata.mockResolvedValue(metadataWithFullPicture());
    mockedGetPalette.mockResolvedValue(["rgba(0, 0, 0, 0.8)"]);

    const { result } = renderHook(() =>
      useNowPlayingMetadata(makeTrack(), "token"),
    );
    await flushMicrotasks();

    expect(result.current.coverUrl).toBe(BLOB_URL);
    expect(mockedGetPalette).toHaveBeenCalledTimes(1);
    expect(mockedGetPalette).toHaveBeenCalledWith(BLOB_URL);
  });

  it("builds the cover from the thumb picture bytes when no full picture exists", async () => {
    mockedGetTrackMetadata.mockResolvedValue(metadataWithPicture());
    mockedGetPalette.mockResolvedValue(["rgba(0, 0, 0, 0.8)"]);

    const { result } = renderHook(() =>
      useNowPlayingMetadata(makeTrack(), "token"),
    );
    await flushMicrotasks();

    expect(result.current.coverUrl).toBe(BLOB_URL);
    expect(mockedGetPalette).toHaveBeenCalledTimes(1);
    expect(mockedGetPalette).toHaveBeenCalledWith(BLOB_URL);
  });

  it("keeps coverUrl null and skips the palette when there is no picture at all", async () => {
    mockedGetTrackMetadata.mockResolvedValue({
      ...metadataWithPicture(),
      pictureData: null,
      pictureDataFull: null,
    });

    const { result } = renderHook(() =>
      useNowPlayingMetadata(makeTrack(), "token"),
    );
    await flushMicrotasks();

    expect(result.current.coverUrl).toBeNull();
    expect(mockedGetPalette).not.toHaveBeenCalled();
  });

  it("creates exactly one blob URL from the picture bytes and never revokes it", async () => {
    mockedGetTrackMetadata.mockResolvedValue(metadataWithPicture());
    mockedGetPalette.mockResolvedValue(["rgba(0, 0, 0, 0.8)"]);

    const { result } = renderHook(() =>
      useNowPlayingMetadata(makeTrack(), "token"),
    );
    await flushMicrotasks();

    expect(result.current.coverUrl).toBe(BLOB_URL);
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLSpy).not.toHaveBeenCalled();
  });

  it("resets the palette when the blob palette decode fails (one attempt only)", async () => {
    mockedGetTrackMetadata.mockResolvedValue(metadataWithPicture());
    mockedGetPalette.mockRejectedValue(new Error("Image load error"));

    const { result } = renderHook(() =>
      useNowPlayingMetadata(makeTrack(), "token"),
    );
    await flushMicrotasks();

    // The blob URL stays set (the bytes are still the best cover we have) but
    // the color treatment is dropped.
    expect(result.current.coverUrl).toBe(BLOB_URL);
    expect(mockedGetPalette).toHaveBeenCalledTimes(1);
    expect(mockedCaptureError).toHaveBeenCalledTimes(1);
    expect(result.current.bgColor).toBe("");
    expect(result.current.bgPalette).toEqual([]);
  });

  it("does not create a blob URL when there are no picture bytes (icon path)", async () => {
    mockedGetTrackMetadata.mockResolvedValue({
      ...metadataWithPicture(),
      pictureData: null,
      pictureDataFull: null,
    });
    mockedGetPalette.mockRejectedValue(new Error("Image load error"));

    const { result } = renderHook(() =>
      useNowPlayingMetadata(makeTrack(), "token"),
    );
    await flushMicrotasks();

    expect(createObjectURLSpy).not.toHaveBeenCalled();
    expect(result.current.coverUrl).toBeNull();
    expect(mockedGetPalette).not.toHaveBeenCalled();
  });

  it("logs a warn via captureError with the module source when palette decoding fails", async () => {
    mockedGetTrackMetadata.mockResolvedValue(metadataWithPicture());
    mockedGetPalette.mockRejectedValue(new Error("decode failed"));

    const { result } = renderHook(() =>
      useNowPlayingMetadata(makeTrack(), "token"),
    );
    await flushMicrotasks();

    expect(mockedCaptureError).toHaveBeenCalledTimes(1);
    expect(mockedCaptureError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        source: "useNowPlayingMetadata",
        message: expect.stringContaining("palette-failed") as unknown as string,
      }),
    );
    // A failed palette must not leave the previous track's colors behind.
    expect(result.current.bgColor).toBe("");
    expect(result.current.bgPalette).toEqual([]);
  });

  it("does not log via captureError when metadata rejects with AbortError (cleanup abort is not an error)", async () => {
    mockedGetTrackMetadata.mockRejectedValue(
      new DOMException("Aborted", "AbortError"),
    );

    renderHook(() => useNowPlayingMetadata(makeTrack(), "token"));
    await flushMicrotasks();

    expect(mockedCaptureError).not.toHaveBeenCalled();
  });
});
