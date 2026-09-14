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
  it("remove enabled → click gọi onRemoveFromQueue + setIsOpen(false)", () => {
    const onRemoveFromQueue = vi.fn();
    const props = renderItems({ onRemoveFromQueue });

    fireEvent.click(
      screen.getByRole("button", { name: "queue.remove_from_queue" }),
    );

    expect(props.setIsOpen).toHaveBeenCalledWith(false);
    expect(onRemoveFromQueue).toHaveBeenCalledTimes(1);
  });

  it("disableRemoveFromQueue → disabled, click không gọi callback, có title hint", () => {
    const onRemoveFromQueue = vi.fn();
    renderItems({ onRemoveFromQueue, disableRemoveFromQueue: true });

    const btn = screen.getByRole("button", {
      name: "queue.remove_from_queue",
    });
    expect(btn).toBeDisabled();
    expect(btn.title).toBe("queue.current_cannot_remove");

    fireEvent.click(btn);
    expect(onRemoveFromQueue).not.toHaveBeenCalled();
  });

  it("có onRemoveFolderFromQueue → item folder render + click gọi; không truyền → KHÔNG render", () => {
    const onRemoveFolderFromQueue = vi.fn();
    const withFolder = renderItems({ onRemoveFolderFromQueue });

    fireEvent.click(
      screen.getByRole("button", { name: "queue.remove_folder" }),
    );
    expect(withFolder.setIsOpen).toHaveBeenCalledWith(false);
    expect(onRemoveFolderFromQueue).toHaveBeenCalledTimes(1);

    cleanup();
    renderItems();
    expect(
      screen.queryByRole("button", { name: "queue.remove_folder" }),
    ).toBeNull();
  });

  it("Download/Navigate click → gọi đúng handler", () => {
    const props = renderItems();
    const { track } = props;

    fireEvent.click(screen.getByRole("button", { name: "menu.download_song" }));
    expect(props.handleDownloadClick).toHaveBeenCalledTimes(1);
    expect(props.handleDownloadClick).toHaveBeenCalledWith(
      expect.anything(),
      track,
      props.setIsOpen,
    );

    fireEvent.click(screen.getByRole("button", { name: "menu.navigate" }));
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
      screen.queryByRole("button", { name: "menu.download_song" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "queue.remove_from_queue" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "menu.navigate" }));
    expect(props.handleNavigateClick).toHaveBeenCalledTimes(1);

    fireEvent.click(
      screen.getByRole("button", { name: "queue.remove_folder" }),
    );
    expect(props.setIsOpen).toHaveBeenCalledWith(false);
    expect(onRemoveFolderFromQueue).toHaveBeenCalledTimes(1);
  });

  it("folder branch thiếu onRemoveFolderFromQueue → KHÔNG render Remove Folder (chỉ Navigate)", () => {
    renderItems({
      track: undefined,
      queueFolder: { id: "f1", name: "Album F1" },
    });

    expect(screen.getByRole("button", { name: "menu.navigate" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "queue.remove_folder" }),
    ).toBeNull();
  });
});
