// @vitest-environment jsdom
/**
 * useVideoFirstFrame — the push/pull contract for "a frame of THIS media item
 * is on screen".
 *
 *  1. The Rust push event (`video-first-frame`) is the fast path.
 *  2. The pull complement (`video_host_first_frame_presented`) recovers a
 *     one-shot signal whose event the listener missed, but only AFTER the
 *     listener is live — never before, so no window exists where neither path
 *     can deliver.
 *  3. Neither path may mark a NEW media item ready from a signal that belongs
 *     to a previous one (the `previous.key === mediaKey` guard).
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useVideoFirstFrame,
  VIDEO_FIRST_FRAME_EVENT,
} from "./useVideoFirstFrame";

const coreMocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: coreMocks.invoke }));

const eventMocks = vi.hoisted(() => ({
  listen: vi.fn(),
  handlers: [] as Array<() => void>,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: eventMocks.listen }));

eventMocks.listen.mockImplementation((name: string, handler: () => void) => {
  if (name === VIDEO_FIRST_FRAME_EVENT) eventMocks.handlers.push(handler);
  return Promise.resolve(vi.fn());
});

/** The pull command whose replies the tests steer. */
const PULL_COMMAND = "video_host_first_frame_presented";

beforeEach(() => {
  coreMocks.invoke.mockReset();
  coreMocks.invoke.mockResolvedValue(undefined);
  eventMocks.listen.mockClear();
  eventMocks.handlers.length = 0;
});

async function deliverEvent(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    for (const handler of [...eventMocks.handlers]) handler();
  });
}

describe("useVideoFirstFrame", () => {
  it("no media: nothing is subscribed and the answer stays false", () => {
    const { result } = renderHook(() => useVideoFirstFrame(null));
    expect(result.current).toBe(false);
    expect(eventMocks.listen).not.toHaveBeenCalled();
    expect(coreMocks.invoke).not.toHaveBeenCalled();
  });

  it("the push event is still the fast path", async () => {
    const { result } = renderHook(() => useVideoFirstFrame("v1"));
    await waitFor(() => {
      expect(eventMocks.handlers).toHaveLength(1);
    });
    expect(result.current).toBe(false);

    await deliverEvent();
    expect(result.current).toBe(true);
  });

  it("pulls once after the listener is live: a missed one-shot self-heals", async () => {
    coreMocks.invoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === PULL_COMMAND ? true : undefined),
    );
    const { result } = renderHook(() => useVideoFirstFrame("v1"));

    await waitFor(() => {
      expect(result.current).toBe(true);
    });
    const pulls = coreMocks.invoke.mock.calls.filter(
      (call) => (call as unknown as [string])[0] === PULL_COMMAND,
    );
    expect(pulls).toHaveLength(1);
  });

  it("the pull happens only after listen resolves, never before", async () => {
    let resolveListen: ((stop: () => void) => void) | undefined;
    eventMocks.listen.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveListen = resolve;
        }),
    );
    coreMocks.invoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === PULL_COMMAND ? true : undefined),
    );

    const { result } = renderHook(() => useVideoFirstFrame("v1"));
    expect(
      coreMocks.invoke.mock.calls.filter(
        (call) => (call as unknown as [string])[0] === PULL_COMMAND,
      ),
    ).toHaveLength(0);

    await act(async () => {
      resolveListen?.(vi.fn());
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current).toBe(true);
    });
  });

  it("a pull resolving true for a STALE media item never marks the new one ready", async () => {
    const pullResolvers: Array<(presented: boolean) => void> = [];
    coreMocks.invoke.mockImplementation((cmd: string) => {
      if (cmd !== PULL_COMMAND) return Promise.resolve(undefined);
      return new Promise<boolean>((resolve) => {
        pullResolvers.push(resolve);
      });
    });

    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useVideoFirstFrame(key),
      { initialProps: { key: "v1" } },
    );
    await waitFor(() => {
      expect(pullResolvers).toHaveLength(1);
    });

    rerender({ key: "v2" });
    await waitFor(() => {
      expect(pullResolvers).toHaveLength(2);
    });
    expect(result.current).toBe(false);

    // The v1 pull answers late (its frame is not the v2 item's frame).
    await act(async () => {
      pullResolvers[0]?.(true);
      await Promise.resolve();
    });
    expect(result.current).toBe(false);

    // The v2 pull answers true: now the new item may be marked ready.
    await act(async () => {
      pullResolvers[1]?.(true);
      await Promise.resolve();
    });
    expect(result.current).toBe(true);
  });

  it("a stale PUSH event (delivered after a media switch) is dropped too", async () => {
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useVideoFirstFrame(key),
      { initialProps: { key: "v1" } },
    );
    await waitFor(() => {
      expect(eventMocks.handlers).toHaveLength(1);
    });

    rerender({ key: "v2" });
    await waitFor(() => {
      expect(eventMocks.handlers).toHaveLength(2);
    });

    // Deliver through the OLD (v1) handler — a signal that raced the switch.
    await act(async () => {
      await Promise.resolve();
      eventMocks.handlers[0]?.();
    });
    expect(result.current).toBe(false);

    // The new handler marks v2.
    await act(async () => {
      await Promise.resolve();
      eventMocks.handlers[1]?.();
    });
    expect(result.current).toBe(true);
  });

  it("a failed pull resolves false and leaves the hook waiting for the push", async () => {
    coreMocks.invoke.mockImplementation((cmd: string) =>
      cmd === PULL_COMMAND
        ? Promise.reject(new Error("not running"))
        : Promise.resolve(undefined),
    );
    const { result } = renderHook(() => useVideoFirstFrame("v1"));
    await waitFor(() => {
      expect(eventMocks.handlers).toHaveLength(1);
    });
    // Let the rejected pull settle.
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBe(false);

    await deliverEvent();
    expect(result.current).toBe(true);
  });
});
