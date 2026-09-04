import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "./db";
import { DriveDatabase } from "./db";
import { get as kvGet, set as kvSet } from "./kv";
import { DEFAULT_USER_EMAIL, USER_EMAIL_KEY } from "../utils/storageKeys";

describe("Dexie storage schema", () => {
  it("exposes typed tables and kv helper", async () => {
    await kvSet("drplay_buffer_seconds", 1400);
    expect(await kvGet("drplay_buffer_seconds")).toBe(1400);
    expect(db.playlists).toBeDefined();
    expect(db.recentTracks).toBeDefined();
    expect(db.metadataCache).toBeDefined();
  });
});

// Migration tests for schema v10 (files per-user scoping): legacy DBs are
// built by opening throwaway Dexie instances that declare ONLY the old
// schema, seeding rows, closing, then opening the real DriveDatabase so the
// real upgrade chain (v9→v10 or v1→v10) runs against seeded data.

const DB_NAME = "DrPlayDriveDB";

// Legacy v9 shape: exactly the store map version(9) declares in db.ts.
class LegacyV9Database extends Dexie {
  constructor() {
    super(DB_NAME);
    this.version(9).stores({
      files: "id, parentId, name, isFolder",
      syncState: "key",
      errorLogs: "id, ts",
      kv: "key",
      playlists: "id, userEmail",
      recentTracksV2: "[userEmail+id], createdAt, [userEmail+createdAt]",
      playCountsV2: "[userEmail+id], [userEmail+count]",
      folderVisitsV2: "[userEmail+id], [userEmail+count]",
      favoritesV2: "[userEmail+id], createdAt",
      uploadSessions: "id, userEmail, status",
    });
  }
}

// Legacy v1 shape: the two tables as shipped in 480d43d.
class LegacyV1Database extends Dexie {
  constructor() {
    super(DB_NAME);
    this.version(1).stores({
      files: "id, parentId, name, isFolder",
      syncState: "key",
    });
  }
}

interface LegacyFileRow {
  id: string;
  name: string;
  mimeType: string;
  parentId: string;
  trashed: boolean;
  isFolder: boolean;
}

const LEGACY_ROWS: LegacyFileRow[] = [
  {
    id: "song1",
    name: "Đổi thay.mp3",
    mimeType: "audio/mpeg",
    parentId: "folderA",
    trashed: false,
    isFolder: false,
  },
  {
    id: "trashed1",
    name: "old.mp3",
    mimeType: "audio/mpeg",
    parentId: "folderA",
    trashed: true,
    isFolder: false,
  },
  {
    id: "pending-abc",
    name: "uploading.mp3",
    mimeType: "audio/mpeg",
    parentId: "root",
    trashed: false,
    isFolder: false,
  },
  {
    id: "folderB",
    name: "Albums",
    mimeType: "application/vnd.google-apps.folder",
    parentId: "root",
    trashed: false,
    isFolder: true,
  },
];

async function seedLegacyFiles(rows: LegacyFileRow[]): Promise<void> {
  const legacy = new LegacyV9Database();
  await legacy.open();
  await legacy.table("files").bulkPut(rows);
  await legacy.table("syncState").put({ key: "cursor", value: "tok-1" });
  legacy.close();
}

describe("schema v10 migration", () => {
  beforeEach(async () => {
    // Fresh database per case: no state leaks between migration flavors.
    await Dexie.delete(DB_NAME);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await Dexie.delete(DB_NAME);
  });

  // The node environment has NO global localStorage at all — the same realm
  // condition a real Web Worker runs under — so this case doubles as the
  // worker-realm safety proof: onupgradeneeded must not crash without
  // localStorage and must fall back to the sentinel owner.
  it("v9→v10 upgrades without localStorage: rows survive stamped with the default sentinel", async () => {
    expect(typeof localStorage).toBe("undefined");
    await seedLegacyFiles(LEGACY_ROWS);

    const upgraded = new DriveDatabase();
    const migrated = await upgraded.files.toArray();

    expect(migrated).toHaveLength(LEGACY_ROWS.length);
    for (const row of migrated) {
      expect(row.userEmail).toBe(DEFAULT_USER_EMAIL);
    }
    // Non-key payload survived the copy intact.
    expect(migrated.find((r) => r.id === "song1")?.parentId).toBe("folderA");
    expect(migrated.find((r) => r.id === "trashed1")?.trashed).toBe(true);
    // Other tables untouched by the v10 copy still read back.
    expect(await upgraded.syncState.get("cursor")).toMatchObject({
      value: "tok-1",
    });
    upgraded.close();
  });

  it("v9→v10 stamps rows with the ACTIVE account when localStorage holds one", async () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) =>
        key === USER_EMAIL_KEY ? "active@example.com" : null,
    });
    await seedLegacyFiles(LEGACY_ROWS);

    const upgraded = new DriveDatabase();
    const migrated = await upgraded.files.toArray();
    for (const row of migrated) {
      expect(row.userEmail).toBe("active@example.com");
    }
    upgraded.close();
  });

  it("v9→v10 serves per-user and pending-id queries through the new indexes", async () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) =>
        key === USER_EMAIL_KEY ? "active@example.com" : null,
    });
    await seedLegacyFiles(LEGACY_ROWS);

    const upgraded = new DriveDatabase();
    // Compound [userEmail+parentId] scopes folder listings to one account…
    const folderA = await upgraded.files
      .where("[userEmail+parentId]")
      .equals(["active@example.com", "folderA"])
      .toArray();
    expect(folderA.map((r) => r.id).sort()).toEqual(["song1", "trashed1"]);
    // …and another account sees nothing of them.
    expect(
      await upgraded.files
        .where("[userEmail+parentId]")
        .equals(["other@example.com", "folderA"])
        .count(),
    ).toBe(0);
    // Standalone "id" index kept for the upload queue ghost sweep.
    const pending = await upgraded.files
      .where("id")
      .startsWith("pending-")
      .toArray();
    expect(pending.map((r) => r.id)).toEqual(["pending-abc"]);
    upgraded.close();
  });

  it("v1→v10 chain upgrades a first-release database end to end", async () => {
    const legacyV1 = new LegacyV1Database();
    await legacyV1.open();
    await legacyV1.table("files").bulkPut(LEGACY_ROWS);
    legacyV1.close();

    const upgraded = new DriveDatabase();
    const migrated = await upgraded.files.toArray();
    expect(migrated).toHaveLength(LEGACY_ROWS.length);
    for (const row of migrated) {
      expect(row.userEmail).toBe(DEFAULT_USER_EMAIL);
    }
    expect(await upgraded.syncState.count()).toBe(0); // nothing seeded here
    upgraded.close();
  });
});
