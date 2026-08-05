import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ERROR_LOG_MAX,
  captureError,
  clearErrorLogs,
  exportErrorLogsSanitized,
  exportErrorLogsSanitizedForDate,
  getErrorLogs,
  groupLogsByDate,
} from "./errorLog";
import type { ErrorLogEntry } from "../db/db";
import { db } from "../db/db";

beforeEach(async () => {
  // Fully wipe the DB between tests so each case starts from a clean slate.
  await db.delete();
  await db.open();
});

describe("captureError", () => {
  it("sanitizes sensitive data (id/token/bearer/link) on capture", async () => {
    await captureError({
      level: "error",
      source: "test",
      message:
        "fetch failed ?id=ABC123xyz access_token=secret Bearer tok http://127.0.0.1:9999/stream?id=X",
    });

    const logs = await getErrorLogs();
    expect(logs).toHaveLength(1);
    const msg = logs[0].message;
    expect(msg).toContain("[REDACTED_ID]");
    expect(msg).toContain("[REDACTED_TOKEN]");
    expect(msg).toContain("[REDACTED_LINK]");
    expect(msg).not.toContain("ABC123xyz");
    expect(msg).not.toContain("access_token=secret");
    expect(msg).not.toContain("Bearer tok");
    expect(msg).not.toContain("http://127.0.0.1:9999/stream?id=X");
  });

  it("caps at ERROR_LOG_MAX and removes oldest", async () => {
    for (let i = 0; i < ERROR_LOG_MAX + 1; i++) {
      await captureError({
        source: "cap",
        message: `entry-${String(i)}`,
        kind: "seq",
      });
    }

    const logs = await getErrorLogs();
    expect(logs).toHaveLength(ERROR_LOG_MAX);

    const tsValues = logs.map((e) => e.ts);
    const minTs = Math.min(...tsValues);
    // entry-0 was captured first => had the smallest ts => must be gone
    const hasEntry0 = await db.errorLogs
      .filter((e) => e.message === "entry-0")
      .count();
    expect(hasEntry0).toBe(0);
    // the smallest remaining ts should be > the deleted one's ts
    expect(minTs).toBeGreaterThan(0);
  });

  it("returns newest-first from getErrorLogs", async () => {
    await captureError({ source: "s", message: "old", kind: "k" });
    await new Promise((r) => setTimeout(r, 5));
    await captureError({ source: "s", message: "new", kind: "k" });

    const logs = await getErrorLogs();
    const oldIdx = logs.findIndex((e) => e.message === "old");
    const newIdx = logs.findIndex((e) => e.message === "new");
    expect(newIdx).toBeLessThan(oldIdx);
    expect(logs[0].message).toBe("new");
  });

  it("does NOT throw when Dexie errors (never throw)", async () => {
    const spy = vi
      .spyOn(db.errorLogs, "add")
      .mockRejectedValueOnce(new Error("db boom"));

    await expect(
      captureError({ source: "s", message: "boom" }),
    ).resolves.toBeUndefined();

    spy.mockRestore();
  });
});

describe("captureError — atomic prune (upgrade)", () => {
  it("prunes 101 entries via a single Dexie transaction", async () => {
    const txSpy = vi.spyOn(db, "transaction");
    let txCalls = 0;
    try {
      for (let i = 0; i < ERROR_LOG_MAX + 1; i++) {
        await captureError({
          source: "atomic-cap",
          message: `atomic-${String(i)}`,
          kind: "seq",
        });
      }
      // Read the call count BEFORE mockRestore: it clears mock.calls.
      txCalls = txSpy.mock.calls.length;
    } finally {
      txSpy.mockRestore();
    }

    const logs = await getErrorLogs();
    expect(logs).toHaveLength(ERROR_LOG_MAX);
    expect(txCalls).toBeGreaterThan(0);
  });
});

describe("getErrorLogs", () => {
  it("returns [] instead of throwing when Dexie read fails (never throw)", async () => {
    const spy = vi.spyOn(db.errorLogs, "orderBy").mockReturnValue({
      reverse: () => ({
        toArray: () => Promise.reject(new Error("read boom")),
      }),
    } as never);

    await expect(getErrorLogs()).resolves.toEqual([]);

    spy.mockRestore();
  });
});

describe("groupLogsByDate", () => {
  it("groups entries by local date and orders newest-first", () => {
    // Two distinct local dates. Use date strings so tz is deterministic per host.
    const dayA = new Date(2023, 10, 1, 10, 0, 0).getTime(); // Nov 1
    const dayB = new Date(2023, 10, 5, 10, 0, 0).getTime(); // Nov 5 (newer)

    const logs: ErrorLogEntry[] = [
      { id: "a1", ts: dayA, level: "error", source: "s", message: "a-old-1" },
      {
        id: "a2",
        ts: dayA + 1000,
        level: "warn",
        source: "s",
        message: "a-old-2",
      },
      {
        id: "a3",
        ts: dayA + 2000,
        level: "info",
        source: "s",
        message: "a-old-3",
      },
      { id: "b1", ts: dayB, level: "error", source: "s", message: "b-new-1" },
      {
        id: "b2",
        ts: dayB + 1000,
        level: "warn",
        source: "s",
        message: "b-new-2",
      },
    ];

    const groups = groupLogsByDate(logs);

    // 2 distinct days -> 2 groups.
    expect(groups).toHaveLength(2);

    // Newest day (dayB) appears first.
    const keyA = new Date(dayA).toLocaleDateString();
    const keyB = new Date(dayB).toLocaleDateString();
    expect(groups[0].dateKey).toBe(keyB);
    expect(groups[1].dateKey).toBe(keyA);

    // Counts correct.
    expect(groups[0].entries).toHaveLength(2);
    expect(groups[1].entries).toHaveLength(3);

    // Entries within a group sorted newest-first by ts.
    expect(groups[0].entries.map((e) => e.id)).toEqual(["b2", "b1"]);
    expect(groups[1].entries.map((e) => e.id)).toEqual(["a3", "a2", "a1"]);
  });

  it("returns [] for empty input (pure, never throws)", () => {
    expect(groupLogsByDate([])).toEqual([]);
    expect(() => groupLogsByDate([])).not.toThrow();
  });

  it("skips entries with invalid ts", () => {
    const valid = new Date(2023, 10, 1, 10, 0, 0).getTime();
    const logs: ErrorLogEntry[] = [
      { id: "ok", ts: valid, level: "error", source: "s", message: "ok" },
      {
        id: "bad",
        ts: Number.NaN,
        level: "error",
        source: "s",
        message: "bad",
      },
    ];
    const groups = groupLogsByDate(logs);
    expect(groups).toHaveLength(1);
    expect(groups[0].entries).toHaveLength(1);
    expect(groups[0].entries[0].id).toBe("ok");
  });
});

describe("exportErrorLogsSanitizedForDate", () => {
  it("returns only entries of the matching local date", async () => {
    const dayA = new Date(2023, 10, 1, 10, 0, 0).getTime();
    const dayB = new Date(2023, 10, 5, 10, 0, 0).getTime();
    await captureError({ source: "s", message: "a1", kind: "k" });
    // Force ts by inserting directly (captureError uses Date.now()).
    await db.errorLogs.add({
      id: "b-x",
      ts: dayB,
      level: "error",
      source: "Bsrc",
      message: "keep-me id=ABC123xyz",
      kind: "k",
    });
    await db.errorLogs.add({
      id: "a-x",
      ts: dayA,
      level: "warn",
      source: "Asrc",
      message: "drop-me",
      kind: "k",
    });

    const keyB = new Date(dayB).toLocaleDateString();
    const out = await exportErrorLogsSanitizedForDate(keyB);
    expect(out).toContain("keep-me");
    expect(out).not.toContain("drop-me");
  });

  it("returns empty string for unknown date", async () => {
    expect(await exportErrorLogsSanitizedForDate("__no_such_date__")).toBe("");
  });
});

describe("clearErrorLogs", () => {
  it("empties all logs", async () => {
    await captureError({ source: "s", message: "a" });
    await captureError({ source: "s", message: "b" });
    expect(await getErrorLogs()).toHaveLength(2);

    await clearErrorLogs();
    expect(await getErrorLogs()).toHaveLength(0);
  });
});

describe("exportErrorLogsSanitized", () => {
  it("formats entries with redacted content", async () => {
    await captureError({
      level: "error",
      source: "src/foo.ts",
      message: "bad id=ABC123xyz",
      stack: "at foo (http://127.0.0.1:9999/stream?id=X:1:1)",
    });

    const out = await exportErrorLogsSanitized();
    expect(out).toContain("error | src/foo.ts");
    expect(out).toContain("[REDACTED_ID]");
    expect(out).toContain("[REDACTED_LINK]");
    expect(out).not.toContain("ABC123xyz");
    expect(out).toMatch(/^\[\d{4}-\d{2}-\d{2}T/);
  });

  it("returns empty string when no logs", async () => {
    expect(await exportErrorLogsSanitized()).toBe("");
  });
});
