// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Track } from "../types";

// In-memory stub for the Dexie `db` module, isolated per test.
// Mirrors the subset of the real `db.favorites` API used by favorites.ts:
//   get([email,id]), put(row), delete([email,id]),
//   where('userEmail').equals(email).toArray(), transaction()
type FavoriteRow = {
  id: string;
  userEmail: string;
  createdAt: number;
  [key: string]: unknown;
};

// The real table uses the compound PK [userEmail+id] (schema v7), so the stub
// keys rows by the same pair. NUL joins the parts collision-free (neither
// emails nor track ids contain NUL).
type FavoriteKey = [string, string];
const keyOf = (userEmail: string, id: string) => `${userEmail}\u0000${id}`;

class InMemoryFavorites {
  private rows = new Map<string, FavoriteRow>();

  get(id: FavoriteKey): FavoriteRow | undefined {
    return this.rows.get(keyOf(id[0], id[1]));
  }

  put(row: FavoriteRow): void {
    this.rows.set(keyOf(row.userEmail, row.id), row);
  }

  delete(id: FavoriteKey): void {
    this.rows.delete(keyOf(id[0], id[1]));
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
        toArray(): FavoriteRow[] {
          return [...rows.values()].filter(
            (r: FavoriteRow) => r[field] === value,
          );
        },
      }),
    };
  }

  clear() {
    this.rows.clear();
  }
}

const store = new InMemoryFavorites();

const { showErrorToastMock } = vi.hoisted(() => ({
  showErrorToastMock: vi.fn(),
}));

// i18n util modules are not hooks — they call i18n.t() directly. The toast
// contract is the KEY (locale text lives in the translation JSONs, checked
// separately by the en/vi parity test), so t is stubbed to return the key.
vi.mock("../i18n", () => ({
  default: { t: (key: string) => key },
}));
vi.mock("./simpleToast", () => ({
  showErrorToast: showErrorToastMock,
}));

vi.mock("../db/db", () => {
  const favoritesTable = {
    get: (id: FavoriteKey) => store.get(id),
    put: (row: FavoriteRow) => {
      store.put(row);
    },
    delete: (id: FavoriteKey) => {
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
      favorites: favoritesTable,
    },
  };
});

vi.mock("./errorLog", () => ({
  captureError: vi.fn(),
}));

import {
  getFavorites,
  addFavorite,
  removeFavorite,
  isFavorite,
} from "./favorites";
import { db } from "../db/db";
import { captureError } from "./errorLog";

const EMAIL_A = "a@example.com";

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
  vi.clearAllMocks();
});

describe("favorites (Dexie-backed)", () => {
  it("addFavorite wraps the read-modify-write in a readwrite transaction and puts the track", async () => {
    setUser(EMAIL_A);
    const txnSpy = vi.spyOn(store, "transaction");
    const putSpy = vi.spyOn(store, "put");

    await addFavorite(track("1"));

    expect(txnSpy).toHaveBeenCalledTimes(1);
    const firstCall = txnSpy.mock.calls[0];
    if (firstCall === undefined) throw new Error("expected txn call");
    expect(firstCall[0]).toBe("rw");
    expect(firstCall[1]).toBe(db.favorites);

    expect(putSpy).toHaveBeenCalledTimes(1);
    const putCall = putSpy.mock.calls[0];
    if (putCall === undefined) throw new Error("expected put call");
    const putArg = putCall[0];
    expect(putArg.id).toBe("1");
    expect(putArg.userEmail).toBe(EMAIL_A);
    expect(putArg.createdAt).toEqual(expect.any(Number));

    txnSpy.mockRestore();
    putSpy.mockRestore();
  });

  it("addFavorite does not put when the track already exists (guard preserved)", async () => {
    setUser(EMAIL_A);
    await addFavorite(track("1"));

    const putSpy = vi.spyOn(store, "put");
    await addFavorite(track("1"));

    expect(putSpy).not.toHaveBeenCalled();
    putSpy.mockRestore();
  });

  it("isFavorite returns false and logs via captureError when the IDB read fails", async () => {
    const getSpy = vi
      .spyOn(store, "get")
      .mockRejectedValueOnce(new Error("boom"));

    const result = await isFavorite("missing");

    expect(result).toBe(false);
    expect(captureError).toHaveBeenCalledTimes(1);
    const firstCall = vi.mocked(captureError).mock.calls[0];
    if (firstCall === undefined) throw new Error("expected captureError call");
    expect(firstCall[0].level).toBe("warn");
    expect(firstCall[0].source).toBe("favorites");
    expect(firstCall[0].message).toContain("is-fav-failed");
    getSpy.mockRestore();
  });

  it("removeFavorite deletes the row and dispatches the update event", async () => {
    setUser(EMAIL_A);
    const handler = vi.fn();
    window.addEventListener("favorites-updated", handler);

    await addFavorite(track("1"));
    await removeFavorite("1");

    expect(handler).toHaveBeenCalledTimes(2);
    expect(await getFavorites()).toEqual([]);

    window.removeEventListener("favorites-updated", handler);
  });

  it("addFavorite shows the localized toast key when the write fails (no hardcoded language)", async () => {
    setUser(EMAIL_A);
    const txnSpy = vi
      .spyOn(store, "transaction")
      .mockRejectedValueOnce(new Error("boom"));

    await addFavorite(track("1"));

    expect(showErrorToastMock).toHaveBeenCalledTimes(1);
    expect(showErrorToastMock).toHaveBeenCalledWith("liked_songs.add_failed");
    txnSpy.mockRestore();
  });

  it("removeFavorite shows the localized toast key when the delete fails (no hardcoded language)", async () => {
    setUser(EMAIL_A);
    const deleteSpy = vi
      .spyOn(db.favorites, "delete")
      .mockRejectedValueOnce(new Error("boom"));

    await removeFavorite("1");

    expect(showErrorToastMock).toHaveBeenCalledTimes(1);
    expect(showErrorToastMock).toHaveBeenCalledWith(
      "liked_songs.remove_failed",
    );
    deleteSpy.mockRestore();
  });
});
