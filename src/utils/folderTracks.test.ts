import { beforeEach, describe, expect, it, vi } from "vitest";
import { FOLDER_MIME } from "./driveTypes";
import type { DriveFileItem } from "./driveTypes";
import { collectFolderTracks, MAX_ADD_TO_QUEUE_TRACKS } from "./folderTracks";

const listFolderAudioFilesMock = vi.hoisted(() => vi.fn());

vi.mock("./drivePagination", () => ({
  listFolderAudioFiles: listFolderAudioFilesMock,
}));

function audio(over: Partial<DriveFileItem> = {}): DriveFileItem {
  return { id: "audio-1", name: "Song.mp3", mimeType: "audio/mpeg", ...over };
}

function folder(id: string, name: string): DriveFileItem {
  return { id, name, mimeType: FOLDER_MIME };
}

// Route each listing call to its folder's fixture; unknown ids return [].
function entriesByFolder(map: Record<string, DriveFileItem[]>): void {
  listFolderAudioFilesMock.mockImplementation(
    (_token: string, folderId: string) => Promise.resolve(map[folderId] ?? []),
  );
}

beforeEach(() => {
  listFolderAudioFilesMock.mockReset();
});

describe("collectFolderTracks", () => {
  it("maps flat folder audio into tracks with stripped titles and folder parent info", async () => {
    entriesByFolder({
      root: [
        audio({ id: "a1", name: "Alpha.mp3", size: "100" }),
        audio({ id: "a2", name: "Beta.flac", size: "200" }),
        audio({ id: "a3", name: "NoSize.ogg" }),
      ],
    });

    const result = await collectFolderTracks("tok", "root", "My Folder");

    expect(result.truncated).toBe(false);
    expect(result.tracks).toEqual([
      {
        id: "a1",
        title: "Alpha",
        artist: "",
        streamUrl: "",
        size: 100,
        originalName: "Alpha.mp3",
        parentId: "root",
        parentName: "My Folder",
      },
      {
        id: "a2",
        title: "Beta",
        artist: "",
        streamUrl: "",
        size: 200,
        originalName: "Beta.flac",
        parentId: "root",
        parentName: "My Folder",
      },
      {
        id: "a3",
        title: "NoSize",
        artist: "",
        streamUrl: "",
        size: undefined,
        originalName: "NoSize.ogg",
        parentId: "root",
        parentName: "My Folder",
      },
    ]);
    expect(listFolderAudioFilesMock).toHaveBeenCalledWith(
      "tok",
      "root",
      undefined,
    );
  });

  it("walks nested folders breadth-first and tracks each parent folder", async () => {
    entriesByFolder({
      root: [audio({ id: "a1", name: "a1.mp3" }), folder("S1", "Sub One")],
      S1: [audio({ id: "s1", name: "s1.mp3" }), folder("S2", "Sub Two")],
      S2: [audio({ id: "s2", name: "s2.mp3" })],
    });

    const { tracks, truncated } = await collectFolderTracks(
      "tok",
      "root",
      "Root",
    );

    expect(truncated).toBe(false);
    expect(tracks.map((t) => t.id)).toEqual(["a1", "s1", "s2"]);
    expect(tracks.map((t) => [t.parentId, t.parentName])).toEqual([
      ["root", "Root"],
      ["S1", "Sub One"],
      ["S2", "Sub Two"],
    ]);
  });

  it("returns empty tracks for an empty folder", async () => {
    entriesByFolder({ root: [] });

    await expect(collectFolderTracks("tok", "root", "Root")).resolves.toEqual({
      tracks: [],
      truncated: false,
    });
  });

  it("caps at MAX_ADD_TO_QUEUE_TRACKS and stops listing further folders", async () => {
    // One queued subfolder plus 1000 root audio = 1001 files total: the cap
    // must be hit while walking root, and the subfolder must never be listed.
    entriesByFolder({
      root: [
        folder("S1", "Deep Folder"),
        ...Array.from({ length: MAX_ADD_TO_QUEUE_TRACKS }, (_, i) =>
          audio({ id: `f${String(i)}`, name: `s${String(i)}.mp3` }),
        ),
      ],
      S1: [audio({ id: "deep", name: "deep.mp3" })],
    });

    const result = await collectFolderTracks("tok", "root", "Root");

    expect(result.tracks).toHaveLength(MAX_ADD_TO_QUEUE_TRACKS);
    expect(result.truncated).toBe(true);
    expect(listFolderAudioFilesMock).toHaveBeenCalledTimes(1);
    expect(listFolderAudioFilesMock).toHaveBeenCalledWith(
      "tok",
      "root",
      undefined,
    );
  });

  it("rejects with AbortError before listing when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      collectFolderTracks("tok", "root", "Root", controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(listFolderAudioFilesMock).not.toHaveBeenCalled();
  });

  it("re-throws the abort raised by a listing call", async () => {
    listFolderAudioFilesMock.mockRejectedValue(
      new DOMException("aborted", "AbortError"),
    );

    await expect(
      collectFolderTracks("tok", "root", "Root"),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("aborts instead of listing the next folder when the signal fires mid-walk", async () => {
    // fetchAllPages can resolve with partial data after an abort, so the
    // collector must re-check the signal after every await.
    const controller = new AbortController();
    listFolderAudioFilesMock.mockImplementation(() => {
      controller.abort();
      return Promise.resolve([folder("S1", "Sub One")]);
    });

    await expect(
      collectFolderTracks("tok", "root", "Root", controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(listFolderAudioFilesMock).toHaveBeenCalledTimes(1);
  });

  it("propagates non-abort listing errors without swallowing them", async () => {
    listFolderAudioFilesMock.mockRejectedValue(new Error("network down"));

    await expect(collectFolderTracks("tok", "root", "Root")).rejects.toThrow(
      "network down",
    );
  });

  it("skips entries whose extension is not playable", async () => {
    entriesByFolder({
      root: [
        audio({ id: "w1", name: "track.wma", mimeType: "audio/x-ms-wma" }),
        audio({ id: "m1", name: "ok.mp3" }),
      ],
    });

    const { tracks } = await collectFolderTracks("tok", "root", "Root");

    expect(tracks.map((t) => t.id)).toEqual(["m1"]);
  });
});
