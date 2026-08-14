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
import type { Track } from "../../../types";

vi.mock("../../../utils/metadata", () => ({
  getTrackMetadata: vi.fn(),
}));

// Task 12: mobile cards must not render the cover image / artist — hoisted
// mock toggles the platform flag; the getter keeps the binding live.
const platformMock = vi.hoisted(() => ({ IS_MOBILE: false }));
vi.mock("../../../utils/platform", () => ({
  get IS_MOBILE() {
    return platformMock.IS_MOBILE;
  },
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

  it("debounces metadata loading: no fetch on mount, fetch after ~150ms", async () => {
    render(<PremiumCard {...baseProps()} />);
    // The fetch must NOT fire immediately — metadata loads queue behind the
    // app-wide fetch semaphore and every scroll-hover of the card would
    // otherwise start a full range-fetch cycle.
    expect(mockedFetch).not.toHaveBeenCalled();
    await screen.findByText("Fetched Title");
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("renders fetched title and artist from metadata", async () => {
    const { container } = render(<PremiumCard {...baseProps()} />);
    await screen.findByText("Fetched Title");
    expect(mockedFetch).toHaveBeenCalledWith(
      "track-1",
      "tok",
      1000,
      "my song.mp3",
      expect.any(Object),
    );
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

describe("PremiumCard blob cover URL (picture bytes, no drplay://)", () => {
  // jsdom does NOT implement URL.createObjectURL / revokeObjectURL (both are
  // undefined at runtime) — install observable spies so the blob URL contract
  // ("the cover renders straight from the picture bytes metadata") can be
  // asserted.
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

  it("renders the cover from a blob URL built with the picture bytes (lazy + async decoding)", async () => {
    const { container } = render(<PremiumCard {...baseProps()} />);
    const img = await screen.findByAltText("Fetched Title");

    expect(img.getAttribute("src")).toMatch(/^blob:/);
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("decoding")).toBe("async");
    expect(container.querySelector(".lucide-music")).toBeNull();
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
  });

  it("drops to the Music icon when the blob image errors (corrupt bytes — no throw)", async () => {
    const { container } = render(<PremiumCard {...baseProps()} />);
    const img = await screen.findByAltText("Fetched Title");
    expect(img.getAttribute("src")).toBe("blob:mock-premium-cover");

    expect(() => fireEvent.error(img)).not.toThrow();

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".lucide-music")).not.toBeNull();
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
  });

  it("prefers the full-resolution picture (pictureDataFull) over the thumb for the blob", async () => {
    mockedFetch.mockResolvedValue({
      title: "Fetched Title",
      artist: "Fetched Artist",
      duration: 0,
      size: 0,
      pictureData: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      pictureDataFull: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      pictureFormat: "image/jpeg",
    } as never);
    const { container } = render(<PremiumCard {...baseProps()} />);
    const img = await screen.findByAltText("Fetched Title");

    expect(img.getAttribute("src")).toMatch(/^blob:/);
    // The blob must be built from the FULL bytes (8), not the thumb (4) —
    // the HomeTab card cover quality fix is about WHICH byte set feeds it.
    const blobArg = createObjectURLSpy.mock.calls[0]?.[0] as Blob;
    expect(blobArg).toBeInstanceOf(Blob);
    expect(blobArg.size).toBe(8);
    expect(blobArg.type).toBe("image/jpeg");
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".lucide-music")).toBeNull();
  });

  it("falls back to the thumb bytes when pictureDataFull is null", async () => {
    mockedFetch.mockResolvedValue({
      title: "Fetched Title",
      artist: "Fetched Artist",
      duration: 0,
      size: 0,
      pictureData: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      pictureDataFull: null,
      pictureFormat: "image/png",
    } as never);
    const { container } = render(<PremiumCard {...baseProps()} />);
    const img = await screen.findByAltText("Fetched Title");

    expect(img.getAttribute("src")).toMatch(/^blob:/);
    const blobArg = createObjectURLSpy.mock.calls[0]?.[0] as Blob;
    expect(blobArg).toBeInstanceOf(Blob);
    expect(blobArg.size).toBe(4);
    expect(blobArg.type).toBe("image/png");
    expect(container.querySelector(".lucide-music")).toBeNull();
  });

  it("creates exactly one blob URL from the picture bytes and never revokes it", async () => {
    const { unmount } = render(<PremiumCard {...baseProps()} />);
    await screen.findByAltText("Fetched Title");
    const blobArg = createObjectURLSpy.mock.calls[0]?.[0] as Blob;
    expect(blobArg).toBeInstanceOf(Blob);
    expect(blobArg.type).toBe("image/png");
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);

    unmount();
    await flushMicrotasks();

    // The blob is intentionally never revoked (covers are small; the browser
    // drops blob URLs on page unload).
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

describe("PremiumCard mobile gate (IS_MOBILE) — title only", () => {
  beforeEach(() => {
    platformMock.IS_MOBILE = true;
    mockedFetch.mockReset();
  });

  afterEach(() => {
    platformMock.IS_MOBILE = false;
    cleanup();
  });

  it("shows the title and the static placeholder tile, but no cover image and no artist", () => {
    const { container } = render(
      <PremiumCard
        {...baseProps()}
        track={{
          id: "track-1",
          title: "My Song",
          artist: "Real Artist",
          streamUrl: "",
        }}
      />,
    );
    expect(screen.getByText("My Song")).not.toBeNull();
    expect(screen.queryByText("Real Artist")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  it("never fetches metadata on mobile (debounce window passes, still no fetch)", async () => {
    render(<PremiumCard {...baseProps()} />);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});
