// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { captureError } from "../utils/errorLog";
import type { NativeAudioEngine } from "./nativeAudioEngine";

const platformMock = vi.hoisted(() => ({ IS_MOBILE: false }));
vi.mock("../utils/platform", () => ({
  get IS_MOBILE() {
    return platformMock.IS_MOBILE;
  },
}));

const invokeMock = vi.hoisted(() => vi.fn());
const addPluginListenerMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  addPluginListener: addPluginListenerMock,
}));

const setStateMock = vi.hoisted(() => vi.fn());
vi.mock("../store/playerStore", () => ({
  usePlayerStore: { getState: () => ({ setIsPlaying: setStateMock }) },
}));

vi.mock("../utils/errorLog", () => ({
  captureError: vi.fn(),
}));

let engine: NativeAudioEngine;

const ENDED_STATE = {
  status: "ended",
  currentTime: 10,
  duration: 10,
  isPlaying: false,
  buffering: false,
  rate: 1,
};

function pluginListener(): (s: unknown) => void {
  const fn = addPluginListenerMock.mock.calls[0]?.[2] as
    ((s: unknown) => void) | undefined;
  if (fn === undefined) throw new Error("expected plugin listener");
  return fn;
}

beforeEach(async () => {
  invokeMock.mockReset();
  addPluginListenerMock.mockReset();
  setStateMock.mockReset();
  vi.mocked(captureError).mockClear();
  addPluginListenerMock.mockResolvedValue(() => {});
  invokeMock.mockResolvedValue({});
  platformMock.IS_MOBILE = true;
  vi.resetModules();
  const mod = await import("./nativeAudioEngine");
  engine = mod.nativeAudioEngine;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("nativeAudioEngine emit isolation", () => {
  it("throw at handler k still delivers payload to k+1 in registration order", async () => {
    await engine.initOnce();
    const order: string[] = [];
    const spy2 = vi.fn(() => {
      order.push("second");
    });
    const spy3 = vi.fn(() => {
      order.push("third");
    });
    engine.on("ended", () => {
      order.push("first");
      throw new Error("boom-first");
    });
    engine.on("ended", spy2);
    engine.on("ended", spy3);

    // Old buggy emit rethrows — swallow it here so the isolation assertions
    // below produce the canonical RED log (spy2 got 0) instead of an abort.
    try {
      pluginListener()(ENDED_STATE);
    } catch {
      // Old behavior: throw propagated and later handlers never ran.
    }

    expect(spy2).toHaveBeenCalledTimes(1);
    expect(spy2).toHaveBeenCalledWith(undefined);
    expect(spy3).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["first", "second", "third"]);
  });

  it("routes each throwing handler to the error pipeline exactly once", async () => {
    await engine.initOnce();
    engine.on("ended", () => {
      throw new Error("boom-pipeline");
    });
    const after = vi.fn();
    engine.on("ended", after);

    try {
      pluginListener()(ENDED_STATE);
    } catch {
      // Old behavior: no pipeline routing, throw propagated.
    }

    expect(after).toHaveBeenCalledTimes(1);
    expect(captureError).toHaveBeenCalledTimes(1);
  });

  it("variant: two throwing handlers do not block the handler after them", async () => {
    await engine.initOnce();
    engine.on("ended", () => {
      throw new Error("boom-1");
    });
    engine.on("ended", () => {
      throw new Error("boom-2");
    });
    const survivor = vi.fn();
    engine.on("ended", survivor);

    try {
      pluginListener()(ENDED_STATE);
    } catch {
      // Old behavior: first throw aborts the whole chain.
    }

    expect(survivor).toHaveBeenCalledTimes(1);
    expect(captureError).toHaveBeenCalledTimes(2);
  });

  it("unsubscribe + emit with no listener neither crashes nor logs", async () => {
    await engine.initOnce();
    const spy = vi.fn();
    const unsub = engine.on("ended", spy);
    unsub();

    expect(() => {
      pluginListener()(ENDED_STATE);
    }).not.toThrow();
    expect(spy).not.toHaveBeenCalled();
    expect(captureError).not.toHaveBeenCalled();
  });
});
