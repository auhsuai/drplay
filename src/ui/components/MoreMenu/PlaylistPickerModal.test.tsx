// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { TFunction } from "i18next";
import { PlaylistPickerModal } from "./PlaylistPickerModal";
import type { Playlist } from "../../../utils/playlists";
import type { Track } from "../../../types";
import en from "../../../locales/en/translation.json";

// Same hoisted platform pattern as MoreMenu.test: the picker compacts its
// rows on IS_MOBILE, so each case picks its platform.
const platformMock = vi.hoisted(() => ({ IS_MOBILE: false }));
vi.mock("../../../utils/platform", () => ({
  get IS_MOBILE() {
    return platformMock.IS_MOBILE;
  },
}));

// t is passed as a prop (PlaylistsSubmenu.test pattern), so react-i18next is
// never initialized here — keys resolve against the real en resources.
const t = ((key: string, fallback?: string) => {
  let acc: unknown = en;
  for (const part of key.split(".")) {
    if (typeof acc === "object" && acc !== null) {
      acc = (acc as Record<string, unknown>)[part];
    } else {
      return fallback ?? "";
    }
  }
  return (typeof acc === "string" ? acc : fallback) ?? "";
}) as unknown as TFunction;

function makePlaylist(id: string, name: string): Playlist {
  return { id, userEmail: "me@example.com", name, createdAt: 1, tracks: [] };
}

function makeTrack(): Track {
  return {
    id: "track-1",
    title: "My Song",
    artist: "Artist",
    streamUrl: "https://example.com/song",
    size: 1000,
    parentId: "parent-1",
    parentName: "Folder One",
  };
}

function renderPicker(playlists: Playlist[], open = true) {
  return render(
    <PlaylistPickerModal
      open={open}
      playlists={playlists}
      track={makeTrack()}
      onClose={vi.fn()}
      onPick={vi.fn()}
      t={t}
    />,
  );
}

describe("PlaylistPickerModal", () => {
  afterEach(() => {
    platformMock.IS_MOBILE = false;
    cleanup();
  });

  it("renders nothing while closed", () => {
    const { container } = renderPicker(
      [makePlaylist("p1", "Playlist One")],
      false,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a labelled dialog with the heading and every playlist listed", () => {
    renderPicker([
      makePlaylist("p1", "Playlist One"),
      makePlaylist("p2", "Party"),
    ]);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Add to Playlist" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Playlist One" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Party" })).toBeTruthy();
  });

  it("moves initial focus into the search input (ModalShell initialFocusRef)", () => {
    renderPicker([makePlaylist("p1", "Playlist One")]);
    expect(document.activeElement).toBe(
      screen.getByPlaceholderText("Search..."),
    );
  });

  it("filters playlists diacritics-insensitively as the user types", () => {
    renderPicker([makePlaylist("p1", "Đổi mới"), makePlaylist("p2", "Party")]);
    fireEvent.change(screen.getByPlaceholderText("Search..."), {
      target: { value: "doi" },
    });
    expect(screen.getByRole("button", { name: "Đổi mới" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Party" })).toBeNull();
  });

  it("shows the empty-state message when no playlists exist", () => {
    renderPicker([]);
    expect(screen.getByText("No playlists yet")).toBeTruthy();
  });

  it("calls onPick with the clicked playlist id", () => {
    const onPick = vi.fn();
    render(
      <PlaylistPickerModal
        open
        playlists={[makePlaylist("p1", "Playlist One")]}
        track={makeTrack()}
        onClose={vi.fn()}
        onPick={onPick}
        t={t}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Playlist One" }));
    expect(onPick).toHaveBeenCalledTimes(1);
    const firstCall = onPick.mock.calls[0];
    if (firstCall === undefined) throw new Error("expected onPick call");
    expect(firstCall[1]).toBe("p1");
  });

  it("compacts rows on mobile and keeps the desktop row tokens", () => {
    platformMock.IS_MOBILE = true;
    const { unmount } = renderPicker([makePlaylist("p1", "Playlist One")]);
    const mobileRow = screen.getByRole("button", { name: "Playlist One" });
    expect(mobileRow.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["py-1.5", "text-[13px]"]),
    );
    unmount();

    platformMock.IS_MOBILE = false;
    renderPicker([makePlaylist("p1", "Playlist One")]);
    const desktopRow = screen.getByRole("button", { name: "Playlist One" });
    expect(desktopRow.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["py-2", "text-sm"]),
    );
  });
});
