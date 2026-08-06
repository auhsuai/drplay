// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { triggerProSync } from "../utils/proSyncManager";
import {
  FOCUS_TRIGGER_DEBOUNCE_MS,
  PRO_SYNC_POLL_MS,
  useProSyncPoller,
} from "./useProSyncPoller";

vi.mock("../utils/proSyncManager", () => ({
  triggerProSync: vi.fn(),
}));

const mockedTriggerProSync = vi.mocked(triggerProSync);

// Fake only timers (never setImmediate) so React's scheduler keeps flushing
// on the real event loop while the poll/debounce timers stay controllable —
// the same pattern as useSearchWorker.test.tsx.
const FAKE_TIMERS_TOFAKE = [
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "Date",
] as const;

// NOTE: @testing-library/react auto-cleanup only runs when vitest globals are
// enabled (they are not — see vitest.config.ts), so every mounted hook must be
// unmounted explicitly here; otherwise the interval/listeners of one test leak
// into the next (counts accumulate across tests).
let unmountHook: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers({ toFake: [...FAKE_TIMERS_TOFAKE] });
  mockedTriggerProSync.mockClear();
});

afterEach(() => {
  unmountHook?.();
  unmountHook = undefined;
  vi.useRealTimers();
  // Remove the own visibilityState property added by tests so the jsdom
  // prototype default ("visible") is restored for the next test.
  delete (document as { visibilityState?: unknown }).visibilityState;
});

function mountPoller(active: boolean) {
  const hook = renderHook(() => {
    useProSyncPoller(active);
  });
  unmountHook = hook.unmount;
  return hook;
}

describe("useProSyncPoller", () => {
  it("triggers a sync immediately on mount while active", () => {
    mountPoller(true);

    expect(mockedTriggerProSync).toHaveBeenCalledTimes(1);
  });

  it("does nothing while inactive (no mount trigger, no interval)", () => {
    mountPoller(false);

    expect(mockedTriggerProSync).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(PRO_SYNC_POLL_MS * 3);
    });
    expect(mockedTriggerProSync).not.toHaveBeenCalled();
  });

  it("fires a sync trigger on every poll interval", () => {
    mountPoller(true);
    mockedTriggerProSync.mockClear();

    act(() => {
      vi.advanceTimersByTime(PRO_SYNC_POLL_MS);
    });
    expect(mockedTriggerProSync).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(PRO_SYNC_POLL_MS);
    });
    expect(mockedTriggerProSync).toHaveBeenCalledTimes(2);
  });

  it("triggers a debounced sync on window focus", () => {
    mountPoller(true);
    mockedTriggerProSync.mockClear();

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    // Debounced: nothing before the debounce window elapses.
    expect(mockedTriggerProSync).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(FOCUS_TRIGGER_DEBOUNCE_MS);
    });
    expect(mockedTriggerProSync).toHaveBeenCalledTimes(1);
  });

  it("collapses rapid focus bursts into a single debounced trigger", () => {
    mountPoller(true);
    mockedTriggerProSync.mockClear();

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    act(() => {
      vi.advanceTimersByTime(FOCUS_TRIGGER_DEBOUNCE_MS - 500);
      window.dispatchEvent(new Event("focus"));
    });
    act(() => {
      vi.advanceTimersByTime(FOCUS_TRIGGER_DEBOUNCE_MS - 500);
      window.dispatchEvent(new Event("focus"));
    });

    act(() => {
      vi.advanceTimersByTime(FOCUS_TRIGGER_DEBOUNCE_MS - 1);
    });
    expect(mockedTriggerProSync).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(mockedTriggerProSync).toHaveBeenCalledTimes(1);
  });

  it("triggers on visibilitychange to visible (not hidden), debounced", () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    mountPoller(true);
    mockedTriggerProSync.mockClear();

    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => {
      vi.advanceTimersByTime(FOCUS_TRIGGER_DEBOUNCE_MS);
    });
    expect(mockedTriggerProSync).not.toHaveBeenCalled();

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => {
      vi.advanceTimersByTime(FOCUS_TRIGGER_DEBOUNCE_MS);
    });
    expect(mockedTriggerProSync).toHaveBeenCalledTimes(1);
  });

  it("stops polling and removes listeners on unmount", () => {
    mountPoller(true);
    mockedTriggerProSync.mockClear();

    unmountHook?.();
    unmountHook = undefined;

    act(() => {
      vi.advanceTimersByTime(PRO_SYNC_POLL_MS * 3);
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(FOCUS_TRIGGER_DEBOUNCE_MS);
    });
    expect(mockedTriggerProSync).not.toHaveBeenCalled();
  });

  it("cancels a pending focus debounce on unmount", () => {
    mountPoller(true);
    mockedTriggerProSync.mockClear();

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    unmountHook?.();
    unmountHook = undefined;

    act(() => {
      vi.advanceTimersByTime(FOCUS_TRIGGER_DEBOUNCE_MS);
    });
    expect(mockedTriggerProSync).not.toHaveBeenCalled();
  });

  it("stops when deactivated and restarts (with mount trigger) when reactivated", () => {
    const hook = renderHook(
      ({ active }: { active: boolean }) => {
        useProSyncPoller(active);
      },
      { initialProps: { active: true } },
    );
    unmountHook = hook.unmount;
    expect(mockedTriggerProSync).toHaveBeenCalledTimes(1);
    mockedTriggerProSync.mockClear();

    hook.rerender({ active: false });
    act(() => {
      vi.advanceTimersByTime(PRO_SYNC_POLL_MS * 3);
      window.dispatchEvent(new Event("focus"));
      vi.advanceTimersByTime(FOCUS_TRIGGER_DEBOUNCE_MS);
    });
    expect(mockedTriggerProSync).not.toHaveBeenCalled();

    hook.rerender({ active: true });
    expect(mockedTriggerProSync).toHaveBeenCalledTimes(1);
  });
});
