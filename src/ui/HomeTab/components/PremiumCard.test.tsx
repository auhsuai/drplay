// @vitest-environment jsdom
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  beforeAll,
} from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  act,
  fireEvent,
} from "@testing-library/react";
import type { MockInstance } from "vitest";
import { PremiumCard } from "./PremiumCard";
import { getTrackMetadata } from "../../../utils/metadata";
import type { Track } from "../../../App";

vi.mock("../../../utils/metadata", () => ({
  getTrackMetadata: vi.fn(),
}));

vi.mock("../../../utils/errorLog", () => ({
  captureError: vi.fn(),
}));

import { captureError } from "../../../utils/errorLog";

const mockedFetch = vi.mocked(getTrackMetadata);
const mockedCaptureError = vi.mocked(captureError);

function makeTrack(over: Partial<Track> = {}): Track {
  return {
    id: "track-1",
    title: "My Song",
    artist: "",
    streamUrl: "",
    size: 1000,
    originalName: "my song.mp3",
    ...over,
  };
}

function baseProps(over: Partial<Parameters<typeof PremiumCard>[0]> = {}) {
  return {
    track: makeTrack(),
    onPlay: () => {},
    token: "tok",
    ...over,
  };
}

describe("PremiumCard metadata render", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    mockedFetch.mockResolvedValue({
      title: "Fetched Title",
      artist: "Fetched Artist",
      pictureData: null,
      pictureFormat: undefined,
    } as never);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders fetched title and artist from metadata", async () => {
    const { container } = render(<PremiumCard {...baseProps()} />);
    expect(mockedFetch).toHaveBeenCalledWith(
      "track-1",
      "tok",
      1000,
      "my song.mp3",
      expect.any(Object),
    );
    await screen.findByText("Fetched Title");
    expect(container.querySelector("img")).toBeNull();
  });

  it("shows fallback placeholder when no cover data resolves", async () => {
    mockedFetch.mockResolvedValue({
      title: "Fetched Title",
      artist: "Fetched Artist",
      pictureData: null,
      pictureFormat: undefined,
    } as never);
    const { container } = render(<PremiumCard {...baseProps()} />);
    await screen.findByText("Fetched Title");
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("PremiumCard drplay:// cover URL (S4 disk-cache path)", () => {
  // jsdom does NOT implement URL.createObjectURL / revokeObjectURL (both are
  // undefined at runtime) — install observable spies once so the S4 contract
  // "the blob path is gone, no blob URL is ever created" can be asserted.
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

  function metadataWithPicture(): never {
    return {
      title: "Fetched Title",
      artist: "Fetched Artist",
      duration: 0,
      size: 0,
      pictureData: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      pictureFormat: "image/png",
    } as never;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockedFetch.mockResolvedValue(metadataWithPicture());
    createObjectURLSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:mock-premium-cover");
    revokeObjectURLSpy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  async function flushMicrotasks() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("renders the thumb via drplay:// with lazy + async decoding", async () => {
    const { container } = render(<PremiumCard {...baseProps()} />);
    const img = await screen.findByAltText("Fetched Title");

    expect(img.getAttribute("src")).toBe(
      "drplay://cover?id=track-1&thumb=true",
    );
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("decoding")).toBe("async");
    expect(container.querySelector(".lucide-music")).toBeNull();
  });

  it("falls back to the Music icon when the drplay:// image errors (no throw)", async () => {
    const { container } = render(<PremiumCard {...baseProps()} />);
    const img = await screen.findByAltText("Fetched Title");

    expect(() => fireEvent.error(img)).not.toThrow();

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".lucide-music")).not.toBeNull();
  });

  it("never creates or revokes blob URLs (blob path removed, RAM goal)", async () => {
    const { unmount } = render(<PremiumCard {...baseProps()} />);
    await screen.findByAltText("Fetched Title");
    await flushMicrotasks();

    expect(createObjectURLSpy).not.toHaveBeenCalled();

    unmount();
    await flushMicrotasks();

    expect(createObjectURLSpy).not.toHaveBeenCalled();
    expect(revokeObjectURLSpy).not.toHaveBeenCalled();
  });
});

describe("PremiumCard metadata rejection handling (abort-skip + captureError)", () => {
  function deferredRejectable() {
    let resolve!: (value: never) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<never>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  beforeEach(() => {
    mockedFetch.mockReset();
    mockedCaptureError.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("calls captureError with module context when metadata fetch rejects while mounted (no unhandled rejection)", async () => {
    mockedFetch.mockRejectedValue(new Error("boom"));

    render(<PremiumCard {...baseProps()} />);

    await waitFor(() => {
      expect(mockedCaptureError).toHaveBeenCalledTimes(1);
    });
    expect(mockedCaptureError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        source: "PremiumCard",
        message: expect.stringContaining(
          "metadata-load-failed",
        ) as unknown as string,
      }),
    );
  });

  it("skips captureError when the fetch rejects after unmount (deliberate cleanup abort)", async () => {
    const d = deferredRejectable();
    mockedFetch.mockImplementationOnce(() => d.promise);

    const { unmount } = render(<PremiumCard {...baseProps()} />);
    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledTimes(1);
    });

    unmount();
    cleanup();

    await act(async () => {
      d.reject(new Error("aborted"));
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockedCaptureError).not.toHaveBeenCalled();
  });
});
