// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "../../types";
import { TrackInfo } from "./TrackInfo";
import { useAuthStore } from "../../store/authStore";
import { getTrackMetadata } from "../../utils/metadata";
import en from "../../locales/en/translation.json";

vi.mock("react-i18next", () => {
  // Resolve keys against the real en resources so assertions read the
  // shipped copy instead of hard-coded fallbacks.
  const resolveKey = (key: string): string | undefined => {
    let acc: unknown = en;
    for (const part of key.split(".")) {
      if (typeof acc === "object" && acc !== null) {
        acc = (acc as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }
    return typeof acc === "string" ? acc : undefined;
  };
  return {
    useTranslation: () => ({
      t: (key: string, fallback?: string) => resolveKey(key) ?? fallback ?? key,
    }),
  };
});

const mocks = vi.hoisted(() => ({
  isFavorite: vi.fn<(trackId: string) => Promise<boolean>>(),
  addFavorite: vi.fn<(track: Track) => Promise<void>>(),
  removeFavorite: vi.fn<(trackId: string) => Promise<void>>(),
}));

vi.mock("../../utils/favorites", () => ({
  isFavorite: mocks.isFavorite,
  addFavorite: mocks.addFavorite,
  removeFavorite: mocks.removeFavorite,
  // Mirrors the constant from favorites.ts so the test-side dispatch uses
  // the same event name the component under test listens for.
  FAVORITES_UPDATED_EVENT: "favorites-updated",
}));

// TrackInfo fetches cover metadata per track; the real module pulls heavy
// deps (music-metadata, IndexedDB) not needed here. V_PLACEHOLDER /
// UNKNOWN_ARTIST are mirrored so TrackInfo's real-entry guard works in tests.
vi.mock("../../utils/metadata", () => ({
  getTrackMetadata: vi.fn(),
  V_PLACEHOLDER: 9,
  UNKNOWN_ARTIST: "Unknown Artist",
}));

const mockedGetTrackMetadata = vi.mocked(getTrackMetadata);

// Task 12: on mobile the bar shows title only — no cover, no artist, and the
// TrackInfo metadata fetch is skipped. Hoisted mock toggles the platform
// flag; the getter keeps the named-export binding live.
const platformMock = vi.hoisted(() => ({ IS_MOBILE: false }));
vi.mock("../../utils/platform", () => ({
  get IS_MOBILE() {
    return platformMock.IS_MOBILE;
  },
}));

// The real MoreMenu pulls heavy deps (driveApi, db, playlists, uploads). A
// stub trigger button keeps this file hermetic while still asserting that
// TrackInfo places the menu inside the (formerly `hidden lg:flex`) wrapper.
vi.mock("../components/MoreMenu", async () => {
  const React = await import("react");
  return {
    MoreMenu: () =>
      React.createElement("button", {
        type: "button",
        "aria-haspopup": "menu",
        "aria-label": "More options",
      }),
  };
});

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: "track-1",
    title: "Song",
    artist: "Artist",
    streamUrl: "/drive-stream/track-1",
    ...overrides,
  };
}

function renderTrackInfo() {
  return render(
    <TrackInfo currentTrack={makeTrack()} onExpandNowPlaying={vi.fn()} />,
  );
}

beforeEach(() => {
  mocks.isFavorite.mockReset();
  mocks.addFavorite.mockReset();
  mocks.removeFavorite.mockReset();
  mocks.isFavorite.mockResolvedValue(false);
  mocks.addFavorite.mockResolvedValue(undefined);
  mocks.removeFavorite.mockResolvedValue(undefined);
  platformMock.IS_MOBILE = false;
});

afterEach(() => {
  cleanup();
  platformMock.IS_MOBILE = false;
});

describe("TrackInfo mobile heart + MoreMenu (Task 13 — fix hidden lg:flex)", () => {
  beforeEach(() => {
    platformMock.IS_MOBILE = true;
  });

  it("mobile: heart + MoreMenu wrapper is VISIBLE (no hidden class) and both controls live in it", async () => {
    renderTrackInfo();
    const heart = await screen.findByRole("button", {
      name: "Add to favorites",
    });
    const menu = screen.getByRole("button", { name: "More options" });
    const wrapper = heart.parentElement as HTMLElement;
    expect(wrapper).toBe(menu.parentElement);
    expect(wrapper.className).not.toContain("hidden");
  });

  it("mobile: heart button is compact (h-7 w-7 touch target, 16px icon)", async () => {
    renderTrackInfo();
    const heart = await screen.findByRole("button", {
      name: "Add to favorites",
    });
    expect(heart.className).toContain("h-7");
    expect(heart.className).toContain("w-7");
    expect(heart.className).not.toContain("h-8");
    expect(heart.querySelector("svg")?.getAttribute("class")).toContain("w-4");
  });

  it("mobile: heart click still toggles like through addFavorite", async () => {
    renderTrackInfo();
    const heart = await screen.findByRole("button", {
      name: "Add to favorites",
    });
    fireEvent.click(heart);
    await screen.findByRole("button", { name: "Remove from favorites" });
    expect(mocks.addFavorite).toHaveBeenCalledTimes(1);
    expect(mocks.removeFavorite).not.toHaveBeenCalled();
  });

  it("desktop regression: wrapper keeps hidden lg:flex, heart keeps p-1 + 20px icon", async () => {
    platformMock.IS_MOBILE = false;
    renderTrackInfo();
    const heart = await screen.findByRole("button", {
      name: "Add to favorites",
    });
    const wrapper = heart.parentElement as HTMLElement;
    expect(wrapper.className).toContain("hidden");
    expect(wrapper.className).toContain("lg:flex");
    expect(heart.className).not.toContain("h-8");
    expect(heart.className).toContain("p-1");
    expect(heart.querySelector("svg")?.getAttribute("class")).toContain("w-5");
  });
});

describe("TrackInfo reactive auth token (getState → selector)", () => {
  beforeEach(() => {
    useAuthStore.setState({ accessToken: null });
    mockedGetTrackMetadata.mockReset();
    mockedGetTrackMetadata.mockResolvedValue({
      title: "Song",
      artist: "Artist",
      duration: 0,
      durationEstimated: false,
      size: 0,
      pictureData: null,
      pictureDataFull: null,
      v: 9,
    } as never);
  });

  afterEach(() => {
    useAuthStore.setState({ accessToken: null });
  });

  it("re-fetches cover metadata with the refreshed token when accessToken changes mid-session", async () => {
    useAuthStore.setState({ accessToken: "tok-A" });
    renderTrackInfo();

    await waitFor(() => {
      expect(mockedGetTrackMetadata).toHaveBeenCalledWith(
        "track-1",
        "tok-A",
        undefined,
        undefined,
        expect.any(Object),
      );
    });

    useAuthStore.setState({ accessToken: "tok-B" });
    await waitFor(() => {
      expect(mockedGetTrackMetadata).toHaveBeenCalledWith(
        "track-1",
        "tok-B",
        undefined,
        undefined,
        expect.any(Object),
      );
    });
  });
});
