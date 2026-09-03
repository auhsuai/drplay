import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "./db";
import { canonicalParent, upsertFileRows } from "./fileRows";

beforeEach(async () => {
  await db.files.clear();
});

afterEach(async () => {
  await db.files.clear();
});

describe("canonicalParent", () => {
  it("derives parentId from parents[0] of the drive response", () => {
    expect(canonicalParent(["ancestor-x", "other"])).toBe("ancestor-x");
  });

  it("falls back to the root sentinel when parents is missing or empty", () => {
    expect(canonicalParent(undefined)).toBe("root");
    expect(canonicalParent([])).toBe("root");
  });
});

describe("upsertFileRows", () => {
  it("stores rows with parentId from parents[0], never from the browsed folder", async () => {
    await upsertFileRows([
      {
        id: "f1",
        name: "song.mp3",
        mimeType: "audio/mpeg",
        parents: ["true-parent"],
        trashed: false,
        isFolder: false,
      },
    ]);

    const row = await db.files.get("f1");
    expect(row?.parentId).toBe("true-parent");
    // The raw parents array must not leak into the stored row.
    expect(row).not.toHaveProperty("parents");
  });

  it("falls back to the root sentinel row when parents is absent", async () => {
    await upsertFileRows([
      {
        id: "f2",
        name: "orphan.mp3",
        mimeType: "audio/mpeg",
        trashed: false,
        isFolder: false,
      },
    ]);

    const row = await db.files.get("f2");
    expect(row?.parentId).toBe("root");
  });

  it("is idempotent by primary key: re-upserting the same id overwrites, never duplicates", async () => {
    const row = {
      id: "f3",
      name: "same.mp3",
      mimeType: "audio/mpeg",
      parents: ["p1"],
      trashed: false,
      isFolder: false,
    };
    await upsertFileRows([row]);
    await upsertFileRows([row]);

    expect(await db.files.where("id").equals("f3").count()).toBe(1);
  });
});
