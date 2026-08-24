import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db";
import {
  canonicalParent,
  upsertFileRows,
  type UpsertableFileRow,
} from "./fileRows";
import { ROOT_FOLDER_ID } from "../utils/driveConstants";

function makeRow(
  overrides: Partial<UpsertableFileRow> & Pick<UpsertableFileRow, "id">,
): UpsertableFileRow {
  return {
    name: "song.mp3",
    mimeType: "audio/mpeg",
    trashed: false,
    isFolder: false,
    ...overrides,
  };
}

describe("canonicalParent", () => {
  it("prefers parents[0] of the response as the single source of truth", () => {
    expect(canonicalParent(["folder-Y", "other"])).toBe("folder-Y");
  });

  it("falls back to ROOT_FOLDER_ID when parents is undefined", () => {
    expect(canonicalParent(undefined)).toBe(ROOT_FOLDER_ID);
  });

  it("falls back to ROOT_FOLDER_ID when parents is an empty array", () => {
    expect(canonicalParent([])).toBe(ROOT_FOLDER_ID);
  });
});

describe("upsertFileRows", () => {
  afterEach(async () => {
    await db.files.clear();
  });

  it("stamps userEmail and derives parentId from parents[0] of the response", async () => {
    await upsertFileRows(
      [makeRow({ id: "f1", name: "Đổi thay.mp3", parents: ["folder-Y"] })],
      "user@example.com",
    );

    const row = await db.files.get("f1");
    expect(row).toMatchObject({
      id: "f1",
      name: "Đổi thay.mp3",
      mimeType: "audio/mpeg",
      trashed: false,
      isFolder: false,
      parentId: "folder-Y",
      userEmail: "user@example.com",
    });
  });

  it("is idempotent per PK id: a second call with different parents overwrites, never duplicates", async () => {
    await upsertFileRows(
      [makeRow({ id: "f1", parents: ["folder-X"] })],
      "user@example.com",
    );
    await upsertFileRows(
      [makeRow({ id: "f1", parents: ["folder-Z"] })],
      "user@example.com",
    );

    const all = await db.files.toArray();
    expect(all).toHaveLength(1);
    expect(all[0]?.parentId).toBe("folder-Z");
  });

  it("throws a named TypeError on empty/whitespace ownerEmail BEFORE writing anything", async () => {
    await upsertFileRows([makeRow({ id: "keep" })], "ok@example.com");

    await expect(upsertFileRows([], "")).rejects.toThrow(TypeError);
    await expect(upsertFileRows([], "   ")).rejects.toThrow(/ownerEmail/);

    // Fail fast: the invalid call must not have touched existing rows.
    await expect(upsertFileRows([makeRow({ id: "nope" })], "")).rejects.toThrow(
      TypeError,
    );
    expect(await db.files.get("nope")).toBeUndefined();
    expect(await db.files.get("keep")).toBeDefined();
  });

  it("persists rows missing optional fields (undefined passthrough) and roots their parent", async () => {
    await upsertFileRows([makeRow({ id: "bare" })], "user@example.com");

    const row = await db.files.get("bare");
    expect(row?.size).toBeUndefined();
    expect(row?.modifiedTime).toBeUndefined();
    expect(row?.metadata).toBeUndefined();
    expect(row?.trashed).toBe(false);
    expect(row?.isFolder).toBe(false);
    expect(row?.parentId).toBe(ROOT_FOLDER_ID);
  });
});
