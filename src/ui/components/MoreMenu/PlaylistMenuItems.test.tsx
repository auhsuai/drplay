// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";
import { PlaylistMenuItems } from "./PlaylistMenuItems";
import type { Track } from "../../../types";

const t = ((key: string) => key) as unknown as TFunction;

function makeTrack(): Track {
  return {
    id: "track-1",
    title: "My Song",
    artist: "Artist",
    streamUrl: "/drive-stream/track-1",
    parentId: "folder-1",
    parentName: "Folder One",
  };
}

function renderItems(
  over: Partial<React.ComponentProps<typeof PlaylistMenuItems>> = {},
) {
  const props = {
    track: makeTrack(),
    handleNavigateClick: vi.fn(),
    onSelectMultiple: vi.fn(),
    onRemoveFromPlaylist: vi.fn(),
    setIsOpen: vi.fn(),
    onClose: vi.fn(),
    t,
    ...over,
  };
  render(<PlaylistMenuItems {...props} />);
  return props;
}

afterEach(() => {
  cleanup();
});

describe("PlaylistMenuItems", () => {
  it("renders exactly Select multiple / Locate File / Remove from Playlist (no file-management items)", () => {
    renderItems();

    expect(
      screen.getAllByRole("menuitem").map((b) => b.textContent?.trim()),
    ).toEqual([
      "menu.select_multiple",
      "menu.navigate",
      "remove_from_playlist",
    ]);

    for (const absent of [
      "menu.download_song",
      "menu.delete",
      "menu.move_to",
      "menu.add_to_queue",
    ]) {
      expect(screen.queryByRole("menuitem", { name: absent })).toBeNull();
    }
  });

  it("renders nothing without a track", () => {
    renderItems({ track: undefined });

    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
  });

  it("Select multiple click -> setIsOpen(false) + onClose + onSelectMultiple", () => {
    const props = renderItems();

    fireEvent.click(
      screen.getByRole("menuitem", { name: "menu.select_multiple" }),
    );

    expect(props.setIsOpen).toHaveBeenCalledWith(false);
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onSelectMultiple).toHaveBeenCalledTimes(1);
    expect(props.onRemoveFromPlaylist).not.toHaveBeenCalled();
    expect(props.handleNavigateClick).not.toHaveBeenCalled();
  });

  it("Locate File click -> handleNavigateClick only (menu close is the shared handler's job)", () => {
    const props = renderItems();

    fireEvent.click(screen.getByRole("menuitem", { name: "menu.navigate" }));

    expect(props.handleNavigateClick).toHaveBeenCalledTimes(1);
    expect(props.setIsOpen).not.toHaveBeenCalled();
    expect(props.onSelectMultiple).not.toHaveBeenCalled();
    expect(props.onRemoveFromPlaylist).not.toHaveBeenCalled();
  });

  it("Remove from Playlist click -> setIsOpen(false) + onClose + onRemoveFromPlaylist", () => {
    const props = renderItems();

    fireEvent.click(
      screen.getByRole("menuitem", { name: "remove_from_playlist" }),
    );

    expect(props.setIsOpen).toHaveBeenCalledWith(false);
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onRemoveFromPlaylist).toHaveBeenCalledTimes(1);
    expect(props.onSelectMultiple).not.toHaveBeenCalled();
  });

  it("click does not throw when the optional callbacks are absent", () => {
    renderItems({
      onSelectMultiple: undefined,
      onRemoveFromPlaylist: undefined,
    });

    expect(() => {
      fireEvent.click(
        screen.getByRole("menuitem", { name: "menu.select_multiple" }),
      );
      fireEvent.click(
        screen.getByRole("menuitem", { name: "remove_from_playlist" }),
      );
    }).not.toThrow();
  });
});
