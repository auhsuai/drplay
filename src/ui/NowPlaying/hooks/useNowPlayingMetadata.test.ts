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
import type { Track } from "../../../App";
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

describe("useNowPlayingMetadata drplay:// cover URL (S4 disk-cache path)", () => {
  function metadataWithFullPicture(): CachedMetadata {
    return {
      ...metadataWithPicture(),
      pictureDataFull: new Uint8Array([9, 9, 9, 9]),
    };
  }

  it("prefers the full variant URL (thumb=false) and passes it to getPalette", async () => {
    mockedGetTrackMetadata.mockResolvedValue(metadataWithFullPicture());

    const { result } = renderHook(() =>
      useNowPlayingMetadata(makeTrack(), "token"),
    );
    await flushMicrotasks();

    expect(result.current.coverUrl).toBe(
      "drplay://cover?id=file-123&thumb=false",
    );
    expect(mockedGetPalette).toHaveBeenCalledWith(
      "drplay://cover?id=file-123&thumb=false",
    );
  });

  it("falls back to the thumb variant URL (thumb=true) when no full picture exists", async () => {
    mockedGetTrackMetadata.mockResolvedValue(metadataWithPicture());

    const { result } = renderHook(() =>
      useNowPlayingMetadata(makeTrack(), "token"),
    );
    await flushMicrotasks();

    expect(result.current.coverUrl).toBe(
      "drplay://cover?id=file-123&thumb=true",
    );
    expect(mockedGetPalette).toHaveBeenCalledWith(
      "drplay://cover?id=file-123&thumb=true",
    );
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

  it("never creates or revokes blob URLs (blob path removed, RAM goal)", async () => {
    mockedGetTrackMetadata.mockResolvedValue(metadataWithPicture());

    renderHook(() => useNowPlayingMetadata(makeTrack(), "token"));
    await flushMicrotasks();

    expect(createObjectURLSpy).not.toHaveBeenCalled();
    expect(revokeObjectURLSpy).not.toHaveBeenCalled();
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
