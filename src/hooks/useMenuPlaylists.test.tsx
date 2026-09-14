// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import type { MouseEvent } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";
import { useMenuPlaylists } from "./useMenuPlaylists";
import { addTrackToPlaylist } from "../utils/playlists";
import type { Track } from "../types";

vi.mock("../utils/playlists", () => ({
  getPlaylists: vi.fn(() => Promise.resolve([])),
  addTrackToPlaylist: vi.fn(),
}));

vi.mock("../utils/simpleToast", () => ({
  showErrorToast: vi.fn(),
}));

vi.mock("../utils/errorLog", () => ({
  captureError: vi.fn(),
}));

const tStub = ((key: string) => key) as unknown as TFunction;

const track: Track = {
  id: "t1",
  title: "Title",
  artist: "Artist",
  streamUrl: "",
};

function clickEvent(): MouseEvent {
  return { stopPropagation: vi.fn() } as unknown as MouseEvent;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// B14-3: addTrackToPlaylist reports failure via its boolean result instead of
// rejecting, so the menu must stay open when it returns false.
describe("useMenuPlaylists add-to-playlist (B14-3)", () => {
  it("add thành công (true) → đóng menu + gọi onClose", async () => {
    vi.mocked(addTrackToPlaylist).mockResolvedValueOnce(true);
    const { result } = renderHook(() => useMenuPlaylists(false, tStub));
    const setIsOpen = vi.fn();
    const onClose = vi.fn();

    await act(async () => {
      await result.current.handleAddToPlaylist(
        clickEvent(),
        "p1",
        track,
        setIsOpen,
        onClose,
      );
    });

    expect(setIsOpen).toHaveBeenCalledWith(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("add thất bại (false) → menu KHÔNG đóng", async () => {
    vi.mocked(addTrackToPlaylist).mockResolvedValueOnce(false);
    const { result } = renderHook(() => useMenuPlaylists(false, tStub));
    const setIsOpen = vi.fn();
    const onClose = vi.fn();

    await act(async () => {
      await result.current.handleAddToPlaylist(
        clickEvent(),
        "p1",
        track,
        setIsOpen,
        onClose,
      );
    });

    expect(setIsOpen).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
