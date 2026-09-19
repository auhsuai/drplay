// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// In-memory kv backend so the tests exercise the module against a real
// get/set/del contract (mirrors db/kv.ts: undefined = missing key).
const kvStore = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../db/kv", () => ({
  get: vi.fn((key: string) => Promise.resolve(kvStore.get(key))),
  set: vi.fn((key: string, value: unknown) => {
    kvStore.set(key, value);
    return Promise.resolve();
  }),
  del: vi.fn((key: string) => {
    kvStore.delete(key);
    return Promise.resolve();
  }),
}));

vi.mock("./errorLog", () => ({ captureError: vi.fn() }));

import { captureError } from "./errorLog";
import {
  PLAYER_PERSISTENCE_KEYS,
  clearPlayerPersistence,
  readPlayMode,
  readQueue,
  readSession,
  writePlayMode,
  writeQueue,
  writeSession,
} from "./playerPersistence";
import { USER_EMAIL_KEY } from "./storageKeys";
import type { Track } from "../types";

const SESSION_KEY = PLAYER_PERSISTENCE_KEYS.session;
const QUEUE_KEY = PLAYER_PERSISTENCE_KEYS.queue;
const PLAY_MODE_KEY = PLAYER_PERSISTENCE_KEYS.playMode;

const ALICE = "alice@example.com";
const BOB = "bob@example.com";

function makeTrack(id: string): Track {
  return {
    id,
    title: `Title ${id}`,
    artist: "Artist",
    streamUrl: `/stream/${id}`,
    queueItemId: `q-${id}`,
  };
}

const captureErrorMock = vi.mocked(captureError);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  kvStore.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("playerPersistence scoped round-trip (a)", () => {
  it("(a) có account → ghi/đọc qua key ::email với payload version 2", async () => {
    localStorage.setItem(USER_EMAIL_KEY, ALICE);
    const session = { track: makeTrack("t1"), time: 12, duration: 240 };
    const queue = [makeTrack("t1"), makeTrack("t2")];

    writeSession(session);
    await writeQueue(queue);
    await writePlayMode("shuffle");

    // Write always lands on the scoped key with the additive v2 version field.
    expect(
      JSON.parse(localStorage.getItem(`${SESSION_KEY}::${ALICE}`) ?? "null"),
    ).toEqual({ v: 2, ...session });
    expect(kvStore.get(`${QUEUE_KEY}::${ALICE}`)).toEqual({
      v: 2,
      tracks: queue,
    });
    expect(kvStore.get(`${PLAY_MODE_KEY}::${ALICE}`)).toEqual({
      v: 2,
      mode: "shuffle",
    });
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(kvStore.has(QUEUE_KEY)).toBe(false);
    expect(kvStore.has(PLAY_MODE_KEY)).toBe(false);

    expect(await readSession()).toMatchObject(session);
    expect(await readQueue()).toEqual(queue);
    expect(await readPlayMode()).toBe("shuffle");
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  it("(a2) chưa có account (sentinel default) → ghi vào key legacy global, không tạo ::default", async () => {
    const session = { track: makeTrack("t1"), time: 3, duration: 30 };

    writeSession(session);
    await writeQueue([makeTrack("t1")]);
    await writePlayMode("normal");

    expect(JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null")).toEqual({
      v: 2,
      ...session,
    });
    expect(kvStore.get(QUEUE_KEY)).toEqual({
      v: 2,
      tracks: [makeTrack("t1")],
    });
    expect(kvStore.get(PLAY_MODE_KEY)).toEqual({ v: 2, mode: "normal" });
    expect(localStorage.getItem(`${SESSION_KEY}::default`)).toBeNull();
  });
});

describe("playerPersistence legacy fallback (b)", () => {
  it("(b) chưa có account → đọc payload v1 cũ (session object, queue array, playmode string)", async () => {
    const track = makeTrack("t1");
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ track, time: 5, duration: 100 }),
    );
    kvStore.set(QUEUE_KEY, [track]);
    kvStore.set(PLAY_MODE_KEY, "repeat-all");

    expect(await readSession()).toMatchObject({
      track,
      time: 5,
      duration: 100,
    });
    expect(await readQueue()).toEqual([track]);
    expect(await readPlayMode()).toBe("repeat-all");
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  it("(b2) account có scoped key trống → fallback một lần về legacy v1 (upgrade không mất dữ liệu)", async () => {
    localStorage.setItem(USER_EMAIL_KEY, ALICE);
    const track = makeTrack("legacy-track");
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ track, time: 7, duration: 70 }),
    );
    kvStore.set(QUEUE_KEY, [track]);
    kvStore.set(PLAY_MODE_KEY, "shuffle");

    expect((await readSession())?.track?.id).toBe("legacy-track");
    expect(await readQueue()).toEqual([track]);
    expect(await readPlayMode()).toBe("shuffle");
  });

  it("(b3) scoped v2 có sẵn → thắng legacy cũ", async () => {
    localStorage.setItem(USER_EMAIL_KEY, ALICE);
    const scopedTrack = makeTrack("scoped-track");
    localStorage.setItem(
      `${SESSION_KEY}::${ALICE}`,
      JSON.stringify({ v: 2, track: scopedTrack, time: 1, duration: 10 }),
    );
    kvStore.set(`${QUEUE_KEY}::${ALICE}`, {
      v: 2,
      tracks: [scopedTrack],
    });
    kvStore.set(`${PLAY_MODE_KEY}::${ALICE}`, { v: 2, mode: "repeat-one" });
    kvStore.set(QUEUE_KEY, [makeTrack("legacy-track")]);
    kvStore.set(PLAY_MODE_KEY, "normal");

    expect((await readSession())?.track?.id).toBe("scoped-track");
    expect((await readQueue())?.map((t) => t.id)).toEqual(["scoped-track"]);
    expect(await readPlayMode()).toBe("repeat-one");
  });
});

describe("playerPersistence clear (c)", () => {
  it("(c) clearPlayerPersistence xoá CẢ scoped + legacy (localStorage + kv)", async () => {
    localStorage.setItem(USER_EMAIL_KEY, ALICE);
    writeSession({ track: makeTrack("t1"), time: 1, duration: 10 });
    await writeQueue([makeTrack("t1")]);
    await writePlayMode("shuffle");
    // Legacy residue from a pre-scope install.
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ track: makeTrack("old"), time: 1, duration: 10 }),
    );
    kvStore.set(QUEUE_KEY, [makeTrack("old")]);
    kvStore.set(PLAY_MODE_KEY, "normal");

    clearPlayerPersistence();

    expect(localStorage.getItem(`${SESSION_KEY}::${ALICE}`)).toBeNull();
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    await vi.waitFor(() => {
      expect(kvStore.has(`${QUEUE_KEY}::${ALICE}`)).toBe(false);
      expect(kvStore.has(`${PLAY_MODE_KEY}::${ALICE}`)).toBe(false);
      expect(kvStore.has(`${SESSION_KEY}::${ALICE}`)).toBe(false);
      expect(kvStore.has(QUEUE_KEY)).toBe(false);
      expect(kvStore.has(PLAY_MODE_KEY)).toBe(false);
      expect(kvStore.has(SESSION_KEY)).toBe(false);
    });
  });

  it("(c2) email đã bị xoá trước khi clear (đúng thứ tự logout thật) → scoped key của account vừa dùng vẫn bị xoá", async () => {
    localStorage.setItem(USER_EMAIL_KEY, ALICE);
    writeSession({ track: makeTrack("t1"), time: 1, duration: 10 });
    await writeQueue([makeTrack("t1")]);
    await writePlayMode("shuffle");

    // useAuth removes USER_EMAIL_KEY before the logout cleanup callback runs.
    localStorage.removeItem(USER_EMAIL_KEY);
    clearPlayerPersistence();

    expect(localStorage.getItem(`${SESSION_KEY}::${ALICE}`)).toBeNull();
    await vi.waitFor(() => {
      expect(kvStore.has(`${QUEUE_KEY}::${ALICE}`)).toBe(false);
      expect(kvStore.has(`${PLAY_MODE_KEY}::${ALICE}`)).toBe(false);
      expect(kvStore.has(`${SESSION_KEY}::${ALICE}`)).toBe(false);
    });
  });
});

describe("playerPersistence version + shape validation (d)", () => {
  it("(d1) session v1 (không version) đọc được; v:3 → log corrupt + fallback legacy", async () => {
    localStorage.setItem(USER_EMAIL_KEY, ALICE);
    localStorage.setItem(
      `${SESSION_KEY}::${ALICE}`,
      JSON.stringify({
        v: 3,
        track: makeTrack("future"),
        time: 1,
        duration: 1,
      }),
    );
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ track: makeTrack("old"), time: 2, duration: 20 }),
    );

    const session = await readSession();

    expect(session?.track?.id).toBe("old");
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        source: "playerPersistence",
        message: expect.stringContaining(
          "session-corrupt",
        ) as unknown as string,
      }),
    );
  });

  it("(d2) queue v2 đọc được; v:3 → log queue corrupt + fallback legacy; entry rác bị drop + log", async () => {
    localStorage.setItem(USER_EMAIL_KEY, ALICE);
    kvStore.set(`${QUEUE_KEY}::${ALICE}`, {
      v: 3,
      tracks: [makeTrack("future")],
    });
    kvStore.set(QUEUE_KEY, [null, 42, makeTrack("valid")]);

    const queue = await readQueue();

    expect(queue?.map((t) => t.id)).toEqual(["valid"]);
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        source: "playerPersistence",
        message: expect.stringContaining(
          "session-queue-corrupt",
        ) as unknown as string,
      }),
    );
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        source: "playerPersistence",
        message: "session-queue-dropped-invalid: 2",
      }),
    );
  });

  it("(d3) playmode v2 đọc được; rác → log session-playmode-corrupt + fallback legacy", async () => {
    localStorage.setItem(USER_EMAIL_KEY, ALICE);
    kvStore.set(`${PLAY_MODE_KEY}::${ALICE}`, { v: 3, mode: "shuffle" });
    kvStore.set(PLAY_MODE_KEY, "normal");

    expect(await readPlayMode()).toBe("normal");
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        source: "playerPersistence",
        message: expect.stringContaining(
          "session-playmode-corrupt",
        ) as unknown as string,
      }),
    );

    captureErrorMock.mockClear();
    kvStore.set(`${PLAY_MODE_KEY}::${ALICE}`, "rubbish");
    expect(await readPlayMode()).toBe("normal");
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "playerPersistence",
        message: expect.stringContaining(
          "session-playmode-corrupt",
        ) as unknown as string,
      }),
    );
  });

  it("(d4) JSON hỏng ở localStorage → log session-corrupt + fallback session trong kv", async () => {
    const track = makeTrack("kv-track");
    localStorage.setItem(`${SESSION_KEY}::${ALICE}`, "not-valid-json{{{");
    localStorage.setItem(USER_EMAIL_KEY, ALICE);
    kvStore.set(`${SESSION_KEY}::${ALICE}`, {
      v: 2,
      track,
      time: 9,
      duration: 90,
    });

    const session = await readSession();

    expect(session?.track?.id).toBe("kv-track");
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        source: "playerPersistence",
        message: expect.stringContaining(
          "session-corrupt",
        ) as unknown as string,
      }),
    );
  });
});

describe("playerPersistence account isolation (e)", () => {
  it("(e) account B không thấy queue/playMode/session của A; A vẫn đọc được dữ liệu của A", async () => {
    localStorage.setItem(USER_EMAIL_KEY, ALICE);
    writeSession({ track: makeTrack("a-track"), time: 1, duration: 10 });
    await writeQueue([makeTrack("a-track")]);
    await writePlayMode("shuffle");

    localStorage.setItem(USER_EMAIL_KEY, BOB);
    expect(await readSession()).toBeUndefined();
    expect(await readQueue()).toBeUndefined();
    expect(await readPlayMode()).toBeUndefined();

    writeSession({ track: makeTrack("b-track"), time: 2, duration: 20 });
    await writeQueue([makeTrack("b-track")]);
    await writePlayMode("normal");
    expect((await readSession())?.track?.id).toBe("b-track");
    expect((await readQueue())?.map((t) => t.id)).toEqual(["b-track"]);
    expect(await readPlayMode()).toBe("normal");

    localStorage.setItem(USER_EMAIL_KEY, ALICE);
    expect((await readSession())?.track?.id).toBe("a-track");
    expect((await readQueue())?.map((t) => t.id)).toEqual(["a-track"]);
    expect(await readPlayMode()).toBe("shuffle");
    expect(captureErrorMock).not.toHaveBeenCalled();
  });
});
