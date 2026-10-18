import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "./db";
import { pruneStaleRootRows } from "./pruneRootRows";
import { ROOT_FOLDER_ID } from "../utils/driveConstants";
import { captureError } from "../utils/errorLog";

vi.mock("../utils/errorLog", () => ({ captureError: vi.fn() }));

const mockedCaptureError = vi.mocked(captureError);

const OWNER = "owner@example.com";
const OTHER = "other@example.com";

function row(
  id: string,
  parentId: string,
  isFolder: boolean,
  userEmail: string = OWNER,
) {
  return {
    id,
    name: id,
    mimeType: isFolder ? "application/vnd.google-apps.folder" : "audio/mpeg",
    parentId,
    trashed: false,
    isFolder,
    userEmail,
  };
}

describe("pruneStaleRootRows", () => {
  beforeEach(async () => {
    await db.files.clear();
    mockedCaptureError.mockReset();
  });

  afterEach(async () => {
    await db.files.clear();
  });

  it("foldersOnly=true deletes only stale root FOLDERS of this account", async () => {
    await db.files.bulkPut([
      row("stale-folder", ROOT_FOLDER_ID, true),
      row("stale-media", ROOT_FOLDER_ID, false),
      row("valid-folder", ROOT_FOLDER_ID, true),
      row("nested-folder", "folder-1", true),
      row("other-account-folder", ROOT_FOLDER_ID, true, OTHER),
    ]);

    const deleted = await pruneStaleRootRows(OWNER, new Set(["valid-folder"]), {
      foldersOnly: true,
    });

    expect(deleted).toBe(1);
    expect(await db.files.get([OWNER, "stale-folder"])).toBeUndefined();
    expect(await db.files.get([OWNER, "stale-media"])).toBeDefined();
    expect(await db.files.get([OWNER, "valid-folder"])).toBeDefined();
    expect(await db.files.get([OWNER, "nested-folder"])).toBeDefined();
    expect(await db.files.get([OTHER, "other-account-folder"])).toBeDefined();
    expect(mockedCaptureError).toHaveBeenCalledTimes(1);
    expect(mockedCaptureError).toHaveBeenCalledWith({
      level: "warn",
      source: "db/pruneRootRows",
      message: "pruned-stale-root-rows: deletedCount=1",
    });
  });

  it("foldersOnly=false deletes stale root folders AND media, keeping API ids", async () => {
    await db.files.bulkPut([
      row("stale-folder", ROOT_FOLDER_ID, true),
      row("stale-media", ROOT_FOLDER_ID, false),
      row("valid-media", ROOT_FOLDER_ID, false),
      row("nested-media", "folder-1", false),
      row("other-account-media", ROOT_FOLDER_ID, false, OTHER),
    ]);

    const deleted = await pruneStaleRootRows(OWNER, new Set(["valid-media"]), {
      foldersOnly: false,
    });

    expect(deleted).toBe(2);
    expect(await db.files.get([OWNER, "stale-folder"])).toBeUndefined();
    expect(await db.files.get([OWNER, "stale-media"])).toBeUndefined();
    expect(await db.files.get([OWNER, "valid-media"])).toBeDefined();
    expect(await db.files.get([OWNER, "nested-media"])).toBeDefined();
    expect(await db.files.get([OTHER, "other-account-media"])).toBeDefined();
    expect(mockedCaptureError).toHaveBeenCalledWith({
      level: "warn",
      source: "db/pruneRootRows",
      message: "pruned-stale-root-rows: deletedCount=2",
    });
  });

  it("returns 0 and logs nothing when every cached row is still valid", async () => {
    await db.files.put(row("valid-folder", ROOT_FOLDER_ID, true));

    await expect(
      pruneStaleRootRows(OWNER, new Set(["valid-folder"]), {
        foldersOnly: false,
      }),
    ).resolves.toBe(0);

    expect(await db.files.get([OWNER, "valid-folder"])).toBeDefined();
    expect(mockedCaptureError).not.toHaveBeenCalled();
  });

  it("resolves 0 and logs one warn when the Dexie delete fails", async () => {
    await db.files.put(row("stale-folder", ROOT_FOLDER_ID, true));
    const bulkDeleteSpy = vi
      .spyOn(db.files, "bulkDelete")
      .mockRejectedValueOnce(new Error("QuotaExceededError"));

    try {
      await expect(
        pruneStaleRootRows(OWNER, new Set(), { foldersOnly: false }),
      ).resolves.toBe(0);

      expect(bulkDeleteSpy).toHaveBeenCalledTimes(1);
      expect(mockedCaptureError).toHaveBeenCalledTimes(1);
      expect(mockedCaptureError).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "warn",
          source: "db/pruneRootRows",
          message: expect.stringContaining(
            "prune-stale-root-rows-failed",
          ) as unknown as string,
        }),
      );
    } finally {
      bulkDeleteSpy.mockRestore();
    }
  });
});
