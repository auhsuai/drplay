import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db, type DriveFile } from "./db";
import {
  canonicalParent,
  upsertFileRows,
  upsertPendingCardRows,
  wipeFileRowsForUser,
  type PendingFileCard,
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
    userEmail: "user@example.com",
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

    const row = await db.files.get(["user@example.com", "f1"]);
    expect(row).toMatchObject({
      id: "f1",
      name: "Đổi thay.mp3",
      mimeType: "audio/mpeg",
      trashed: false,
      isFolder: false,
      parentId: "folder-Y",
      userEmail: "user@example.com",
    });
    // The raw parents array must not leak into the stored row.
    expect(row).not.toHaveProperty("parents");
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
    expect(await db.files.get(["ok@example.com", "nope"])).toBeUndefined();
    expect(await db.files.get(["ok@example.com", "keep"])).toBeDefined();
  });

  it("persists rows missing optional fields (undefined passthrough) and roots their parent", async () => {
    await upsertFileRows([makeRow({ id: "bare" })], "user@example.com");

    const row = await db.files.get(["user@example.com", "bare"]);
    expect(row?.size).toBeUndefined();
    expect(row?.modifiedTime).toBeUndefined();
    expect(row?.metadata).toBeUndefined();
    expect(row?.trashed).toBe(false);
    expect(row?.isFolder).toBe(false);
    expect(row?.parentId).toBe(ROOT_FOLDER_ID);
  });

  // Metadata is app-local state (e.g. the streamUnplayable flag persisted by
  // the metadata fetch pipeline via db.files.update) — it never comes from the
  // Drive API, so sync-mapped rows arrive without it. bulkPut replaces whole
  // rows, so the writer must re-attach the existing metadata or every sync
  // would silently erase the flag (see fetchPipeline.ts — "persist the flag on
  // the files row so the player can avoid streaming it").
  describe("metadata survival across sync upserts", () => {
    const PLAYABLE_FLAG = { format: "m4a", streamUnplayable: true };

    it("preserves existing metadata when the incoming row has none", async () => {
      await upsertFileRows(
        [makeRow({ id: "flagged", metadata: PLAYABLE_FLAG })],
        "user@example.com",
      );

      await upsertFileRows(
        [makeRow({ id: "flagged", parents: ["folder-S"] })],
        "user@example.com",
      );

      expect(
        (await db.files.get(["user@example.com", "flagged"]))?.metadata,
      ).toEqual(PLAYABLE_FLAG);
    });

    it("lets an incoming row WITH metadata replace the stored one", async () => {
      await upsertFileRows(
        [makeRow({ id: "replaced", metadata: PLAYABLE_FLAG })],
        "user@example.com",
      );

      await upsertFileRows(
        [makeRow({ id: "replaced", metadata: { format: "mp3" } })],
        "user@example.com",
      );

      expect(
        (await db.files.get(["user@example.com", "replaced"]))?.metadata,
      ).toEqual({ format: "mp3" });
    });

    it("leaves a brand-new row's metadata undefined (no empty object)", async () => {
      await upsertFileRows([makeRow({ id: "fresh" })], "user@example.com");

      const row = await db.files.get(["user@example.com", "fresh"]);
      expect(row).toBeDefined();
      expect(row?.metadata).toBeUndefined();
      expect("metadata" in (row as DriveFile)).toBe(true);
      expect(row?.metadata).not.toBeNull();
    });

    it("handles all three cases in ONE batch upsert call", async () => {
      await db.files.bulkPut([
        {
          ...makeRow({ id: "keep-me" }),
          userEmail: "user@example.com",
          metadata: PLAYABLE_FLAG,
        } as DriveFile,
        {
          ...makeRow({ id: "overwrite-me" }),
          userEmail: "user@example.com",
          metadata: { format: "old" },
        } as DriveFile,
      ]);

      await upsertFileRows(
        [
          makeRow({ id: "keep-me" }), // incoming w/o metadata -> preserved
          makeRow({ id: "overwrite-me", metadata: { format: "new" } }), // incoming wins
          makeRow({ id: "brand-new" }), // no existing -> undefined
        ],
        "user@example.com",
      );

      const kept = await db.files.get(["user@example.com", "keep-me"]);
      const over = await db.files.get(["user@example.com", "overwrite-me"]);
      const fresh = await db.files.get(["user@example.com", "brand-new"]);
      expect(kept?.metadata).toEqual(PLAYABLE_FLAG);
      expect(over?.metadata).toEqual({ format: "new" });
      expect(fresh?.metadata).toBeUndefined();
    });
  });

  // Upload-completion rows: the resumable-upload response is narrowed by
  // asDriveFileItem and never carries `parents[]`, so the caller passes the
  // parent ITSELF sent in the upload request as a fallback source of truth.
  describe("knownParents fallback", () => {
    afterEach(async () => {
      await db.files.clear();
    });

    it("uses knownParents as parentId when the row carries no own parents", async () => {
      await upsertFileRows([makeRow({ id: "up1" })], "user@example.com", [
        "folder-Q",
      ]);

      const row = await db.files.get(["user@example.com", "up1"]);
      expect(row?.parentId).toBe("folder-Q");
    });

    it("prefers the row's OWN parents over the caller-supplied knownParents", async () => {
      await upsertFileRows(
        [makeRow({ id: "up2", parents: ["folder-own"] })],
        "user@example.com",
        ["folder-known"],
      );

      expect((await db.files.get(["user@example.com", "up2"]))?.parentId).toBe(
        "folder-own",
      );
    });

    it("still roots the parent when neither the row nor the caller knows it", async () => {
      await upsertFileRows([makeRow({ id: "up3" })], "user@example.com");

      expect((await db.files.get(["user@example.com", "up3"]))?.parentId).toBe(
        ROOT_FOLDER_ID,
      );
    });
  });
});

// Pending upload cards: synthesized db.files rows standing in for in-flight
// uploads BEFORE Drive knows the file exists (ids "pending-<uuid>"). They have
// no Drive response behind them, so there is no parents[] to canonically
// derive from — the card's self-managed parentId IS the truth for that row.
describe("upsertPendingCardRows", () => {
  afterEach(async () => {
    await db.files.clear();
  });

  function makeCard(
    overrides: Partial<PendingFileCard> & Pick<PendingFileCard, "id">,
  ): PendingFileCard {
    return {
      name: "song.mp3",
      mimeType: "audio/mpeg",
      parentId: "folder-K",
      isFolder: false,
      ...overrides,
    };
  }

  it("keeps the card's self-managed parentId verbatim (no canonical root fallback)", async () => {
    await upsertPendingCardRows(
      [makeCard({ id: "pending-1" })],
      "user@example.com",
    );

    const row = await db.files.get(["user@example.com", "pending-1"]);
    expect(row?.parentId).toBe("folder-K");
  });

  it("stamps ownerEmail and trashed=false, defaulting modifiedTime when absent", async () => {
    const before = Date.now();
    await upsertPendingCardRows(
      [makeCard({ id: "pending-2" })],
      "owner@example.com",
    );

    const row = await db.files.get(["owner@example.com", "pending-2"]);
    expect(row).toMatchObject({
      id: "pending-2",
      name: "song.mp3",
      mimeType: "audio/mpeg",
      parentId: "folder-K",
      trashed: false,
      isFolder: false,
      userEmail: "owner@example.com",
    });
    expect(row?.modifiedTime).toBeDefined();
    expect(Date.parse(row?.modifiedTime ?? "")).toBeGreaterThanOrEqual(before);
  });

  it("honours an explicit modifiedTime instead of defaulting", async () => {
    await upsertPendingCardRows(
      [makeCard({ id: "pending-3", modifiedTime: "2026-01-01T00:00:00Z" })],
      "user@example.com",
    );

    expect(
      (await db.files.get(["user@example.com", "pending-3"]))?.modifiedTime,
    ).toBe("2026-01-01T00:00:00Z");
  });

  it("is idempotent per PK: re-putting the same card overwrites, never duplicates", async () => {
    await upsertPendingCardRows(
      [makeCard({ id: "pending-4", parentId: "folder-A" })],
      "user@example.com",
    );
    await upsertPendingCardRows(
      [makeCard({ id: "pending-4", parentId: "folder-B" })],
      "user@example.com",
    );

    const all = await db.files.toArray();
    expect(all).toHaveLength(1);
    expect(all[0]?.parentId).toBe("folder-B");
  });

  it("throws a named TypeError on empty/whitespace ownerEmail BEFORE writing anything", async () => {
    await upsertPendingCardRows(
      [makeCard({ id: "keep-pending" })],
      "ok@example.com",
    );

    await expect(
      upsertPendingCardRows([makeCard({ id: "x" })], ""),
    ).rejects.toThrow(TypeError);
    await expect(
      upsertPendingCardRows([makeCard({ id: "x" })], "   "),
    ).rejects.toThrow(/ownerEmail/);
    await expect(
      upsertPendingCardRows([makeCard({ id: "nope" })], ""),
    ).rejects.toThrow(TypeError);

    // Fail fast: the invalid calls must not have touched existing rows.
    expect(await db.files.get(["ok@example.com", "nope"])).toBeUndefined();
    expect(
      await db.files.get(["ok@example.com", "keep-pending"]),
    ).toBeDefined();
  });
});

// Logout account-boundary wipe (schema v10): filesV2 rows are keyed
// [userEmail+id], so a logout wipes ONLY the logged-out account's mirror by
// ranging over the compound primary key. Contract mirrors
// wipePersistedMetadataCache: Dexie failures are logged and RESOLVED (a
// fire-and-forget caller treats resolution as "wipe finished"), while an
// invalid ownerEmail rejects eagerly with a named TypeError BEFORE any query.
describe("wipeFileRowsForUser", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.files.clear();
  });

  function ownedRow(id: string, email: string): DriveFile {
    return {
      id,
      name: `${id}.mp3`,
      mimeType: "audio/mpeg",
      parentId: "root",
      trashed: false,
      isFolder: false,
      userEmail: email,
    };
  }

  it("wipes EVERY row of the target account (playable, non-playable, folder) and keeps other accounts' rows", async () => {
    await db.files.bulkPut([
      ownedRow("mp3-A", "a@x"),
      {
        ...ownedRow("wma-A", "a@x"),
        name: "old.wma",
        mimeType: "audio/x-ms-wma",
      },
      {
        ...ownedRow("folder-A", "a@x"),
        name: "Folder",
        mimeType: "application/vnd.google-apps.folder",
        isFolder: true,
      },
      ownedRow("mp3-B", "b@x"),
      {
        ...ownedRow("wma-B", "b@x"),
        name: "theirs.wma",
        mimeType: "audio/x-ms-wma",
      },
    ]);

    await expect(wipeFileRowsForUser("a@x")).resolves.toBeUndefined();

    expect(await db.files.get(["a@x", "mp3-A"])).toBeUndefined();
    expect(await db.files.get(["a@x", "wma-A"])).toBeUndefined();
    expect(await db.files.get(["a@x", "folder-A"])).toBeUndefined();
    // The other account's mirror is untouched.
    expect(await db.files.get(["b@x", "mp3-B"])).toBeDefined();
    expect(await db.files.get(["b@x", "wma-B"])).toBeDefined();
    expect(await db.files.count()).toBe(2);
  });

  it("throws a named TypeError on empty/whitespace ownerEmail BEFORE touching any row", async () => {
    await upsertFileRows([ownedRow("keep", "ok@x")], "ok@x");

    await expect(wipeFileRowsForUser("")).rejects.toThrow(TypeError);
    await expect(wipeFileRowsForUser("   ")).rejects.toThrow(/ownerEmail/);
    await expect(
      wipeFileRowsForUser(undefined as unknown as string),
    ).rejects.toThrow(/ownerEmail/);

    // Fail fast: the invalid calls must not have deleted anything.
    expect(await db.files.get(["ok@x", "keep"])).toBeDefined();
  });

  it("NEVER rejects when Dexie fails: logs a warn and resolves instead", async () => {
    await upsertFileRows([ownedRow("survivor", "a@x")], "a@x");
    vi.spyOn(db.files, "where").mockImplementation(() => {
      throw new Error("simulated IDB failure");
    });

    await expect(wipeFileRowsForUser("a@x")).resolves.toBeUndefined();
    // Best-effort contract: the failed wipe must not have half-deleted data.
    expect(await db.files.get(["a@x", "survivor"])).toBeDefined();
  });
});
