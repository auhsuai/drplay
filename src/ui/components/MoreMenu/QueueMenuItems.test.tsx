// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";
import { QueueMenuItems } from "./QueueMenuItems";
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
    queueItemId: "q-1",
  };
}

function renderItems(
  over: Partial<React.ComponentProps<typeof QueueMenuItems>> = {},
) {
  const props = {
    track: makeTrack(),
    handleDownloadClick: vi.fn(),
    handleNavigateClick: vi.fn(),
    setIsOpen: vi.fn(),
    t,
    ...over,
  };
  render(<QueueMenuItems {...props} />);
  return props;
}

afterEach(() => {
  cleanup();
});

describe("QueueMenuItems", () => {
  it("remove enabled → click gọi onRemoveFromQueue + setIsOpen(false), không có aria-disabled", () => {
    const onRemoveFromQueue = vi.fn();
    const props = renderItems({ onRemoveFromQueue });

    const btn = screen.getByRole("menuitem", {
      name: "queue.remove_from_queue",
    });
    expect(btn).not.toHaveAttribute("aria-disabled");

    fireEvent.click(btn);

    expect(props.setIsOpen).toHaveBeenCalledWith(false);
    expect(onRemoveFromQueue).toHaveBeenCalledTimes(1);
  });

  it("disableRemoveFromQueue → aria-disabled + visual class, click không gọi callback, có title hint", () => {
    const onRemoveFromQueue = vi.fn();
    const props = renderItems({
      onRemoveFromQueue,
      disableRemoveFromQueue: true,
    });

    const btn = screen.getByRole("menuitem", {
      name: "queue.remove_from_queue",
    });
    // APG: disabled menuitem stays focusable and is announced via
    // aria-disabled instead of the native attribute.
    expect(btn).toHaveAttribute("aria-disabled", "true");
    expect(btn.hasAttribute("disabled")).toBe(false);
    expect(btn.title).toBe("queue.current_cannot_remove");
    // P2-08-5: the item styles its own disabled state (aria-disabled does
    // not trigger the `disabled:` pseudo-class).
    const classes = btn.className.split(/\s+/);
    expect(classes).toContain("opacity-50");
    expect(classes).toContain("cursor-not-allowed");

    fireEvent.click(btn);
    expect(onRemoveFromQueue).not.toHaveBeenCalled();
    expect(props.setIsOpen).not.toHaveBeenCalled();
  });

  it("có onRemoveFolderFromQueue → item folder render + click gọi; không truyền → KHÔNG render", () => {
    const onRemoveFolderFromQueue = vi.fn();
    const withFolder = renderItems({ onRemoveFolderFromQueue });

    fireEvent.click(
      screen.getByRole("menuitem", { name: "queue.remove_folder" }),
    );
    expect(withFolder.setIsOpen).toHaveBeenCalledWith(false);
    expect(onRemoveFolderFromQueue).toHaveBeenCalledTimes(1);

    cleanup();
    renderItems();
    expect(
      screen.queryByRole("menuitem", { name: "queue.remove_folder" }),
    ).toBeNull();
  });

  it("Download/Navigate click → gọi đúng handler", () => {
    const props = renderItems();
    const { track } = props;

    fireEvent.click(
      screen.getByRole("menuitem", { name: "menu.download_song" }),
    );
    expect(props.handleDownloadClick).toHaveBeenCalledTimes(1);
    expect(props.handleDownloadClick).toHaveBeenCalledWith(
      expect.anything(),
      track,
      props.setIsOpen,
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "menu.navigate" }));
    expect(props.handleNavigateClick).toHaveBeenCalledTimes(1);
  });

  it("folder branch (không track): CHỈ Navigate + Remove Folder, click gọi đúng handler", () => {
    const onRemoveFolderFromQueue = vi.fn();
    const props = renderItems({
      track: undefined,
      queueFolder: { id: "f1", name: "Album F1" },
      onRemoveFolderFromQueue,
    });

    expect(
      screen.queryByRole("menuitem", { name: "menu.download_song" }),
    ).toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: "queue.remove_from_queue" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("menuitem", { name: "menu.navigate" }));
    expect(props.handleNavigateClick).toHaveBeenCalledTimes(1);

    fireEvent.click(
      screen.getByRole("menuitem", { name: "queue.remove_folder" }),
    );
    expect(props.setIsOpen).toHaveBeenCalledWith(false);
    expect(onRemoveFolderFromQueue).toHaveBeenCalledTimes(1);
  });

  it("folder branch thiếu onRemoveFolderFromQueue → KHÔNG render Remove Folder (chỉ Navigate)", () => {
    renderItems({
      track: undefined,
      queueFolder: { id: "f1", name: "Album F1" },
    });

    expect(
      screen.getByRole("menuitem", { name: "menu.navigate" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("menuitem", { name: "queue.remove_folder" }),
    ).toBeNull();
  });
});
