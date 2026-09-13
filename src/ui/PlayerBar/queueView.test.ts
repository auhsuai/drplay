import { describe, expect, it } from "vitest";
import type { Track } from "../../types";
import { buildQueueView } from "./queueView";

function makeTrack(id: string, extra: Partial<Track> = {}): Track {
  return { id, title: id, artist: "", streamUrl: "", ...extra };
}

// A queue member stamped by collectFolderTracks.
function member(
  id: string,
  folderId: string,
  folderName: string,
  extra: Partial<Track> = {},
): Track {
  return makeTrack(id, {
    folderGroupId: folderId,
    folderGroupName: folderName,
    ...extra,
  });
}

describe("buildQueueView root view", () => {
  it("returns [] for an empty queue", () => {
    expect(buildQueueView([], null, null)).toEqual([]);
  });

  it("keeps loose tracks at their original positions around a folder item", () => {
    const loose1 = makeTrack("loose-1");
    const loose2 = makeTrack("loose-2");
    const tracks = [
      loose1,
      member("m1", "f1", "Folder One"),
      loose2,
      member("m2", "f1", "Folder One"),
    ];

    const items = buildQueueView(tracks, null, null);

    expect(items.map((item) => item.key)).toEqual([
      "loose-1",
      "folder:f1",
      "loose-2",
    ]);
    expect(items.map((item) => item.kind)).toEqual([
      "track",
      "folder",
      "track",
    ]);
    expect(items[0]).toEqual({ kind: "track", key: "loose-1", track: loose1 });
    expect(items[1]).toEqual({
      kind: "folder",
      key: "folder:f1",
      folderId: "f1",
      folderName: "Folder One",
      count: 2,
      containsCurrent: false,
    });
  });

  it("collapses scattered (shuffled) members into one folder item at the first member", () => {
    const loose = makeTrack("loose");
    const tracks = [
      member("m1", "f1", "Folder One"),
      loose,
      member("m2", "f1", "Folder One"),
      member("m3", "f1", "Folder One"),
    ];

    const items = buildQueueView(tracks, null, null);

    expect(items.map((item) => item.key)).toEqual(["folder:f1", "loose"]);
    const folder = items[0];
    expect(folder).toMatchObject({ kind: "folder", count: 3 });
  });

  it("emits multiple folders in first-occurrence order", () => {
    const tracks = [
      member("a", "f2", "Folder Two"),
      makeTrack("loose"),
      member("b", "f1", "Folder One"),
      member("c", "f2", "Folder Two"),
    ];

    const items = buildQueueView(tracks, null, null);

    expect(items.map((item) => item.key)).toEqual([
      "folder:f2",
      "loose",
      "folder:f1",
    ]);
  });

  it("merges two adds of the same folder id into one item with a combined count", () => {
    const tracks = [
      member("same-file", "f1", "Folder One", { queueItemId: "q1" }),
      member("same-file", "f1", "Folder One", { queueItemId: "q2" }),
    ];

    const items = buildQueueView(tracks, null, null);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "folder",
      folderId: "f1",
      count: 2,
    });
  });

  it("uses the first member's name even when it is empty", () => {
    const tracks = [member("m1", "f1", ""), member("m2", "f1", "Late Name")];

    const items = buildQueueView(tracks, null, null);

    expect(items[0]).toMatchObject({ folderName: "" });
  });

  it("marks containsCurrent only for the folder holding the current track", () => {
    const current = member("cur", "f1", "Folder One", { queueItemId: "q-cur" });
    const tracks = [
      member("m1", "f2", "Folder Two", { queueItemId: "q-m1" }),
      current,
      member("m2", "f2", "Folder Two", { queueItemId: "q-m2" }),
    ];

    const items = buildQueueView(tracks, null, current);

    expect(items[0]).toMatchObject({
      kind: "folder",
      folderId: "f2",
      containsCurrent: false,
    });
    expect(items[1]).toMatchObject({
      kind: "folder",
      folderId: "f1",
      containsCurrent: true,
    });
  });

  it("containsCurrent is false when there is no current track", () => {
    const tracks = [member("m1", "f1", "Folder One")];

    expect(buildQueueView(tracks, null, null)[0]).toMatchObject({
      containsCurrent: false,
    });
  });

  it("keys track items by queueItemId when present, else by track id", () => {
    const withItemId = makeTrack("dup-id", { queueItemId: "q-1" });
    const withoutItemId = makeTrack("dup-id");

    const items = buildQueueView([withItemId, withoutItemId], null, null);

    expect(items.map((item) => item.key)).toEqual(["q-1", "dup-id"]);
  });
});

describe("buildQueueView folder view", () => {
  it("returns only that folder's members in queue order as track items", () => {
    const m1 = member("m1", "f1", "Folder One", { queueItemId: "q-m1" });
    const m2 = member("m2", "f1", "Folder One", { queueItemId: "q-m2" });
    const tracks = [
      m1,
      makeTrack("loose"),
      m2,
      member("m3", "f2", "Folder Two"),
    ];

    const items = buildQueueView(tracks, "f1", null);

    expect(items).toEqual([
      { kind: "track", key: "q-m1", track: m1 },
      { kind: "track", key: "q-m2", track: m2 },
    ]);
  });

  it("returns [] for an unknown folder id", () => {
    const tracks = [member("m1", "f1", "Folder One")];

    expect(buildQueueView(tracks, "nope", null)).toEqual([]);
  });

  it("returns [] for an empty queue", () => {
    expect(buildQueueView([], "f1", null)).toEqual([]);
  });
});
