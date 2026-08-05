// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PlaylistRow } from "../db/db";
import type { Track } from "../types";

class InMemoryPlaylists {
  private rows = new Map<string, PlaylistRow>();

  get(id: string): PlaylistRow | undefined {
    return this.rows.get(id);
  }

  put(row: PlaylistRow): void {
    this.rows.set(row.id, row);
  }

  bulkPut(rows: PlaylistRow[]): void {
    for (const r of rows) this.rows.set(r.id, r);
  }

  delete(id: string): void {
    this.rows.delete(id);
  }

  // Minimal Dexie transaction shim: executes the scope function directly.
  // IndexedDB-level serialization is not emulated — the real `db.transaction`
  // call is asserted separately via the spy test below.
  async transaction<T>(
    _mode: string,
    _tables: unknown,
    fn: () => Promise<T>,
  ): Promise<T> {
    return fn();
  }

  where(field: "userEmail") {
    const rows = this.rows;
    return {
      equals: (value: string) => ({
        toArray(): PlaylistRow[] {
          return [...rows.values()].filter((r) => r[field] === value);
        },
      }),
    };
  }

  clear() {
    this.rows.clear();
  }
}

const store = new InMemoryPlaylists();

vi.mock("../db/db", () => {
  const playlistsTable = {
    get: (id: string) => store.get(id),
    put: (row: PlaylistRow) => {
      store.put(row);
    },
    bulkPut: (rows: PlaylistRow[]) => {
      store.bulkPut(rows);
    },
    delete: (id: string) => {
      store.delete(id);
    },
    where: (field: "userEmail") => store.where(field),
  };
  return {
    db: {
      // Dexie's transaction() is a method on the db instance, not the table.
      transaction: (
        mode: string,
        tables: unknown,
        fn: () => Promise<unknown>,
      ) => store.transaction(mode, tables, fn),
      playlists: playlistsTable,
    },
  };
});

import {
  getPlaylists,
  createPlaylist,
  deletePlaylist,
  updatePlaylist,
  addTrackToPlaylist,
  removeTrackFromPlaylist,
  getPlaylistById,
} from "./playlists";
import { db } from "../db/db";

const EMAIL_A = "a@example.com";
const EMAIL_B = "b@example.com";

function setUser(email: string | null) {
  if (email) localStorage.setItem("drplay_current_user_email", email);
  else localStorage.removeItem("drplay_current_user_email");
}

const track = (id: string): Track => ({
  id,
  title: `Track ${id}`,
  artist: "Artist",
  streamUrl: `https://stream/${id}`,
});

beforeEach(() => {
  store.clear();
  localStorage.clear();
});

// Assert the optional value is present and return it narrowed — replaces the
// banned `!` after `expect(x).not.toBeNull()`.
function nonNull<T>(value: T | null, what: string): T {
  expect(value).not.toBeNull();
  if (value === null) throw new Error(`expected ${what}`);
  return value;
}

describe("playlists (Dexie-backed)", () => {
  it("createPlaylist persists a row scoped to the user", async () => {
    setUser(EMAIL_A);
    const created = nonNull(await createPlaylist("My Mix"), "playlist");
    expect(created.name).toBe("My Mix");
    expect(created.tracks).toEqual([]);

    const all = await getPlaylists();
    expect(all).toHaveLength(1);
    expect(all[0].userEmail).toBe(EMAIL_A);
  });

  it("getPlaylists returns empty for a user with no data", async () => {
    setUser(EMAIL_A);
    expect(await getPlaylists()).toEqual([]);
  });

  it("addTrackToPlaylist appends a track and dedupes", async () => {
    setUser(EMAIL_A);
    const p = nonNull(await createPlaylist("Liked"), "playlist");
    await addTrackToPlaylist(p.id, track("1"));
    await addTrackToPlaylist(p.id, track("1"));
    await addTrackToPlaylist(p.id, track("2"));

    const fetched = nonNull(await getPlaylistById(p.id), "playlist");
    expect(fetched.tracks).toHaveLength(2);
    expect(fetched.tracks.map((t) => t.id)).toEqual(["1", "2"]);
  });

  it("removeTrackFromPlaylist removes by track id", async () => {
    setUser(EMAIL_A);
    const p = nonNull(await createPlaylist("Liked"), "playlist");
    await addTrackToPlaylist(p.id, track("1"));
    await addTrackToPlaylist(p.id, track("2"));
    await removeTrackFromPlaylist(p.id, "1");

    const fetched = nonNull(await getPlaylistById(p.id), "playlist");
    expect(fetched.tracks.map((t) => t.id)).toEqual(["2"]);
  });

  it("updatePlaylist merges updates", async () => {
    setUser(EMAIL_A);
    const p = nonNull(await createPlaylist("Liked"), "playlist");
    const updated = nonNull(
      await updatePlaylist(p.id, { coverImage: "data:img" }),
      "playlist",
    );
    expect(updated.coverImage).toBe("data:img");
    expect(updated.name).toBe("Liked");
  });

  it("deletePlaylist removes the row", async () => {
    setUser(EMAIL_A);
    const p = nonNull(await createPlaylist("Temp"), "playlist");
    await deletePlaylist(p.id);
    expect(await getPlaylistById(p.id)).toBeNull();
    expect(await getPlaylists()).toHaveLength(0);
  });

  it("isolates playlists per userEmail", async () => {
    setUser(EMAIL_A);
    await createPlaylist("A1");
    await createPlaylist("A2");
    setUser(EMAIL_B);
    await createPlaylist("B1");

    setUser(EMAIL_A);
    const a = await getPlaylists();
    expect(a).toHaveLength(2);
    expect(a.map((p) => p.name).sort()).toEqual(["A1", "A2"]);

    setUser(EMAIL_B);
    const b = await getPlaylists();
    expect(b).toHaveLength(1);
    expect(b[0].name).toBe("B1");
  });

  it("dispatches a playlists-updated event on mutations", async () => {
    setUser(EMAIL_A);
    const handler = vi.fn();
    window.addEventListener("playlists-updated", handler);

    await createPlaylist("Evt");
    await deletePlaylist((await getPlaylists())[0].id);
    expect(handler).toHaveBeenCalledTimes(2);
    window.removeEventListener("playlists-updated", handler);
  });

  it("addTrackToPlaylist concurrently preserves both tracks (lost-update guard)", async () => {
    setUser(EMAIL_A);
    const p = nonNull(await createPlaylist("Race"), "playlist");
    await Promise.all([
      addTrackToPlaylist(p.id, track("1")),
      addTrackToPlaylist(p.id, track("2")),
    ]);
    const fetched = nonNull(await getPlaylistById(p.id), "playlist");
    expect(fetched.tracks.map((t) => t.id).sort()).toEqual(["1", "2"]);
  });

  it("addTrackToPlaylist wraps the read-modify-write in a readwrite transaction", async () => {
    setUser(EMAIL_A);
    const p = nonNull(await createPlaylist("Txn"), "playlist");
    const spy = vi.spyOn(store, "transaction");
    await addTrackToPlaylist(p.id, track("1"));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe("rw");
    expect(spy.mock.calls[0][1]).toBe(db.playlists);
    spy.mockRestore();
  });
});
