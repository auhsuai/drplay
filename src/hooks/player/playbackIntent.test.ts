import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetPlaybackIntentForTests,
  abortCurrentIntent,
  beginIntent,
  bumpSessionEpoch,
  commitIfCurrent,
  getCurrentIntentSignal,
  getIntentCounters,
  hasActiveUserIntent,
  intentPriority,
  isCurrent,
} from "./playbackIntent";

// The controller is a plain module with process-global state (same pattern as
// utils/playerError and store/playbackCommit), so every test starts from a
// clean slate.
beforeEach(() => {
  __resetPlaybackIntentForTests();
});

describe("playbackIntent — kinds & priority", () => {
  it("user transport kinds are priority user; system lanes are priority system", () => {
    for (const kind of [
      "play",
      "pause",
      "resume",
      "next",
      "prev",
      "stop",
    ] as const) {
      expect(intentPriority(kind)).toBe("user");
    }
    for (const kind of [
      "auto-advance",
      "restore",
      "retry",
      "recovery",
    ] as const) {
      expect(intentPriority(kind)).toBe("system");
    }
  });

  it("beginIntent(user) → current handle, live signal, hasActiveUserIntent", () => {
    const handle = beginIntent("play");

    expect(handle.isCurrent()).toBe(true);
    expect(isCurrent(handle.id)).toBe(true);
    expect(hasActiveUserIntent()).toBe(true);
    expect(handle.abortSignal.aborted).toBe(false);
    expect(getCurrentIntentSignal()).toBe(handle.abortSignal);
  });

  it("a new user intent supersedes the old one: old signal aborted, old commit dropped", () => {
    const a = beginIntent("play");
    const b = beginIntent("next");

    expect(a.isCurrent()).toBe(false);
    expect(a.abortSignal.aborted).toBe(true);
    expect(isCurrent(a.id)).toBe(false);
    expect(b.isCurrent()).toBe(true);
    expect(commitIfCurrent(a.id, () => undefined)).toBe(false);
    expect(getIntentCounters().superseded).toBe(1);
    expect(getIntentCounters().staleDrops).toBe(1);
  });

  it("end() retires the intent WITHOUT aborting its signal (deferred metadata/SW continuations keep it)", () => {
    const handle = beginIntent("play");
    handle.end();

    expect(handle.isCurrent()).toBe(false);
    expect(hasActiveUserIntent()).toBe(false);
    expect(getCurrentIntentSignal()).toBeNull();
    // The signal still backs display-only deferred work after the commit.
    expect(handle.abortSignal.aborted).toBe(false);
  });

  it("handle.abort() kills the signal even after end() (unmount cleanup of deferred work)", () => {
    const handle = beginIntent("play");
    handle.end();
    expect(handle.abortSignal.aborted).toBe(false);

    handle.abort();

    expect(handle.abortSignal.aborted).toBe(true);
  });

  it("commitIfCurrent runs only while the id is current", () => {
    const handle = beginIntent("play");
    let value = 0;

    expect(commitIfCurrent(handle.id, () => (value = 1))).toBe(true);
    expect(value).toBe(1);

    handle.end();
    expect(commitIfCurrent(handle.id, () => (value = 2))).toBe(false);
    expect(value).toBe(1);
  });
});

describe("playbackIntent — system guard (contract (a), audit B5-4)", () => {
  it("system intent is REFUSED while a user intent is in flight — user signal untouched", () => {
    const user = beginIntent("play");
    const system = beginIntent("auto-advance");

    expect(system.isCurrent()).toBe(false);
    expect(system.abortSignal.aborted).toBe(false);
    expect(user.isCurrent()).toBe(true);
    expect(user.abortSignal.aborted).toBe(false);
    expect(hasActiveUserIntent()).toBe(true);
    expect(getIntentCounters().refused).toBe(1);
    expect(getIntentCounters().superseded).toBe(0);
  });

  it("the user intent still commits after a refused system intent", () => {
    const user = beginIntent("play");
    beginIntent("auto-advance");
    let committed = false;

    expect(commitIfCurrent(user.id, () => (committed = true))).toBe(true);
    expect(committed).toBe(true);
  });

  it("system intent is granted when no user intent is active and supersedes older system intent", () => {
    const first = beginIntent("recovery");
    const second = beginIntent("auto-advance");

    expect(first.isCurrent()).toBe(false);
    expect(first.abortSignal.aborted).toBe(true);
    expect(second.isCurrent()).toBe(true);
    expect(hasActiveUserIntent()).toBe(false);
  });

  it("system intent after the user intent ended is granted (no lingering guard)", () => {
    const user = beginIntent("play");
    user.end();

    const system = beginIntent("auto-advance");
    expect(system.isCurrent()).toBe(true);
  });
});

describe("playbackIntent — session epoch / teardown (contracts (b) & (e))", () => {
  it("bumpSessionEpoch invalidates AND aborts every in-flight intent", () => {
    const user = beginIntent("play");

    bumpSessionEpoch();

    expect(user.isCurrent()).toBe(false);
    expect(user.abortSignal.aborted).toBe(true);
    expect(hasActiveUserIntent()).toBe(false);
    expect(isCurrent(user.id)).toBe(false);
    expect(commitIfCurrent(user.id, () => undefined)).toBe(false);
    expect(getIntentCounters().epochBumps).toBe(1);
  });

  it("a fresh intent after the bump is current (next session keeps working)", () => {
    bumpSessionEpoch();
    const handle = beginIntent("play");
    expect(handle.isCurrent()).toBe(true);
  });

  it("bump also kills the signal of an intent that already ended (deferred work must not outlive teardown)", () => {
    const handle = beginIntent("play");
    handle.end();

    bumpSessionEpoch();

    expect(handle.abortSignal.aborted).toBe(true);
  });
});

describe("playbackIntent — abortCurrentIntent owner semantics (H1/UTP-5)", () => {
  it("aborts the current signal but keeps the handle current — owner-checked cleanup still runs", () => {
    const handle = beginIntent("play");

    abortCurrentIntent();

    expect(handle.abortSignal.aborted).toBe(true);
    expect(handle.isCurrent()).toBe(true);

    handle.end();
    expect(handle.isCurrent()).toBe(false);
  });
});
