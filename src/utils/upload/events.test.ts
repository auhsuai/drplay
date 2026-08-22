import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindEntries,
  clearProgressNotifyTimer,
  resetProgressNotify,
  scheduleProgressNotify,
  subscribe,
} from "./events";
import { PROGRESS_NOTIFY_INTERVAL_MS } from "./errors";
import type { InternalEntry } from "./types";

function makeEntry(id: string, progress: number | undefined): InternalEntry {
  return {
    id,
    name: id,
    isFolder: false,
    parentId: "root",
    status: "uploading",
    token: "token",
    kind: "bytes",
    progress,
  };
}

// UPLOAD_CONCURRENCY = 2 (queue.ts pump): two entries report onProgress in
// interleaved bursts. Coalescing state must be PER ENTRY — a shared timer +
// shared last-notified baseline drops/suppresses the sibling's ticks.
describe("scheduleProgressNotify per-entry coalescing", () => {
  let notifies: number;
  let unsub: () => void;
  let entries: InternalEntry[];

  beforeEach(() => {
    vi.useFakeTimers();
    entries = [];
    bindEntries(() => entries);
    notifies = 0;
    unsub = subscribe(() => {
      notifies += 1;
    });
    clearProgressNotifyTimer();
  });

  afterEach(() => {
    unsub();
    clearProgressNotifyTimer();
    vi.useRealTimers();
  });

  it("notifies both concurrent entries whose ticks interleave in one window", () => {
    const a = makeEntry("a", 0.2);
    const b = makeEntry("b", 0.9);
    entries.push(a, b);

    scheduleProgressNotify(a);
    // B's tick lands while A's timer is still pending — B must get its own
    // timer instead of being merged into (dropped by) A's slot.
    scheduleProgressNotify(b);

    vi.advanceTimersByTime(PROGRESS_NOTIFY_INTERVAL_MS);

    expect(notifies).toBe(2);
  });

  it("does not suppress an entry whose value equals another entry's baseline", () => {
    const a = makeEntry("a", 0.5);
    entries.push(a);
    scheduleProgressNotify(a);
    vi.advanceTimersByTime(PROGRESS_NOTIFY_INTERVAL_MS);
    expect(notifies).toBe(1);

    // Same fraction as A's last-notified value, but a DIFFERENT entry.
    const b = makeEntry("b", 0.5);
    entries.push(b);
    scheduleProgressNotify(b);
    vi.advanceTimersByTime(PROGRESS_NOTIFY_INTERVAL_MS);

    expect(notifies).toBe(2);
  });

  it("starting a new upload does not force a sibling to re-announce", () => {
    const a = makeEntry("a", 0.4);
    entries.push(a);
    scheduleProgressNotify(a);
    vi.advanceTimersByTime(PROGRESS_NOTIFY_INTERVAL_MS);
    expect(notifies).toBe(1);

    // processEntry analog for a NEW entry starting while A is mid-flight.
    resetProgressNotify();

    // A repeats its own unchanged value: the per-entry baseline must still
    // suppress it — the reset belonged to the new entry only.
    scheduleProgressNotify(a);
    vi.advanceTimersByTime(PROGRESS_NOTIFY_INTERVAL_MS);
    expect(notifies).toBe(1);
  });

  it("a brand-new entry always fires its first tick after a start-of-upload reset", () => {
    const a = makeEntry("a", 0.3);
    entries.push(a);
    scheduleProgressNotify(a);
    vi.advanceTimersByTime(PROGRESS_NOTIFY_INTERVAL_MS);
    expect(notifies).toBe(1);

    resetProgressNotify(); // processEntry of the next upload
    const fresh = makeEntry("fresh", 0.05);
    entries.push(fresh);
    scheduleProgressNotify(fresh);
    vi.advanceTimersByTime(PROGRESS_NOTIFY_INTERVAL_MS);
    expect(notifies).toBe(2);
  });

  it("leaves no pending timers or records behind when an entry goes terminal", () => {
    const a = makeEntry("a", 0.5);
    entries.push(a);
    scheduleProgressNotify(a);
    expect(vi.getTimerCount()).toBe(1);

    // markDone analog: terminal flip + clear + prune from the live list.
    a.status = "done";
    clearProgressNotifyTimer();
    entries.length = 0;

    // The next burst sweeps the dead record away without resurrecting timers
    // or notifying for the pruned entry.
    const b = makeEntry("b", 0.7);
    entries.push(b);
    scheduleProgressNotify(b);
    vi.advanceTimersByTime(PROGRESS_NOTIFY_INTERVAL_MS * 2);

    expect(vi.getTimerCount()).toBe(0);
    expect(notifies).toBe(1);
  });
});
