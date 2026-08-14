// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

const initOnceMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("../lib/nativeAudioBridge", () => ({
  nativeAudioEngine: { initOnce: initOnceMock },
}));

vi.mock("../utils/errorLog", () => ({
  captureError: vi.fn(),
}));

async function loadUseNativeAudio() {
  const mod = await import("./useNativeAudio");
  return mod.useNativeAudio;
}

describe("useNativeAudio", () => {
  beforeEach(() => {
    initOnceMock.mockClear();
    initOnceMock.mockResolvedValue(undefined);
  });

  it("initializes the native engine once on mount when mobile", async () => {
    vi.doMock("../utils/platform", () => ({ IS_MOBILE: true }));
    vi.resetModules();
    const useNativeAudio = await loadUseNativeAudio();

    const { unmount } = renderHook(() => useNativeAudio());
    await act(async () => {});
    expect(initOnceMock).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("does not initialize when on desktop", async () => {
    vi.doMock("../utils/platform", () => ({ IS_MOBILE: false }));
    vi.resetModules();
    const useNativeAudio = await loadUseNativeAudio();

    renderHook(() => useNativeAudio());
    await act(async () => {});
    expect(initOnceMock).not.toHaveBeenCalled();
  });

  it("logs a warning when initialization fails instead of crashing", async () => {
    vi.doMock("../utils/platform", () => ({ IS_MOBILE: true }));
    vi.resetModules();
    const useNativeAudio = await loadUseNativeAudio();

    initOnceMock.mockRejectedValueOnce(new Error("no permission"));
    renderHook(() => useNativeAudio());
    await act(async () => {});
    expect(initOnceMock).toHaveBeenCalledTimes(1);
  });
});
