// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";
import { SidebarPlaylistMenuItems } from "./SidebarPlaylistMenuItems";
import type { Playlist } from "../../../utils/playlists";

const t = ((key: string) => key) as unknown as TFunction;

function makePlaylist(over: Partial<Playlist> = {}): Playlist {
  return {
    id: "pl-1",
    userEmail: "u@example.com",
    name: "Chill",
    createdAt: 0,
    tracks: [],
    ...over,
  };
}

function renderItems(
  over: Partial<React.ComponentProps<typeof SidebarPlaylistMenuItems>> = {},
) {
  const props = {
    playlist: makePlaylist(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onTogglePin: vi.fn(),
    setIsOpen: vi.fn(),
    onClose: vi.fn(),
    t,
    ...over,
  };
  render(<SidebarPlaylistMenuItems {...props} />);
  return props;
}

afterEach(() => {
  cleanup();
});

describe("SidebarPlaylistMenuItems", () => {
  it("renders exactly Delete / Rename / Pin to top (no track or file actions)", () => {
    renderItems();

    expect(
      screen.getAllByRole("menuitem").map((b) => b.textContent?.trim()),
    ).toEqual(["delete", "rename", "pin_to_top"]);

    for (const absent of [
      "menu.add_to_playlist",
      "menu.download_song",
      "menu.add_to_queue",
      "menu.navigate",
      "menu.select_multiple",
      "remove_from_playlist",
    ]) {
      expect(screen.queryByRole("menuitem", { name: absent })).toBeNull();
    }
  });

  it("swaps the pin item for Unpin from top when the playlist is pinned", () => {
    renderItems({ playlist: makePlaylist({ pinned: true }) });

    expect(
      screen.getAllByRole("menuitem").map((b) => b.textContent?.trim()),
    ).toEqual(["delete", "rename", "unpin_from_top"]);
    expect(screen.queryByRole("menuitem", { name: "pin_to_top" })).toBeNull();
  });

  it("renders nothing without a playlist", () => {
    renderItems({ playlist: undefined });

    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
  });

  it("Delete click -> setIsOpen(false) + onClose + onDelete only", () => {
    const props = renderItems();

    fireEvent.click(screen.getByRole("menuitem", { name: "delete" }));

    expect(props.setIsOpen).toHaveBeenCalledWith(false);
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onDelete).toHaveBeenCalledTimes(1);
    expect(props.onRename).not.toHaveBeenCalled();
    expect(props.onTogglePin).not.toHaveBeenCalled();
  });

  it("Rename click -> setIsOpen(false) + onClose + onRename only", () => {
    const props = renderItems();

    fireEvent.click(screen.getByRole("menuitem", { name: "rename" }));

    expect(props.setIsOpen).toHaveBeenCalledWith(false);
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onRename).toHaveBeenCalledTimes(1);
    expect(props.onDelete).not.toHaveBeenCalled();
    expect(props.onTogglePin).not.toHaveBeenCalled();
  });

  it("Pin click -> setIsOpen(false) + onClose + onTogglePin only", () => {
    const props = renderItems();

    fireEvent.click(screen.getByRole("menuitem", { name: "pin_to_top" }));

    expect(props.setIsOpen).toHaveBeenCalledWith(false);
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onTogglePin).toHaveBeenCalledTimes(1);
    expect(props.onDelete).not.toHaveBeenCalled();
    expect(props.onRename).not.toHaveBeenCalled();
  });

  it("click does not throw when the optional callbacks are absent", () => {
    renderItems({
      onRename: undefined,
      onDelete: undefined,
      onTogglePin: undefined,
    });

    expect(() => {
      fireEvent.click(screen.getByRole("menuitem", { name: "delete" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "rename" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "pin_to_top" }));
    }).not.toThrow();
  });
});
