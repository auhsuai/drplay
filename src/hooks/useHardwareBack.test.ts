// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DOUBLE_BACK_EXIT_MS,
  createDoubleBackExit,
  handleGlobalBack,
  registerNativeBackHandler,
  useHardwareBack,
} from "./useHardwareBack";

// Task 9 mobile-polish upgrade: native back now flows through Tauri's
// official onBackButtonPress event (2.9+) instead of the History-API popstate
// hack. The app plugin is stubbed so registration can be asserted without the
// real IPC, and IS_MOBILE is flipped via the same getter pattern the App tests
// use.
const appApiMock = vi.hoisted(() => ({
  onBackButtonPress: vi.fn(),
  unregister: vi.fn(),
}));
vi.mock("@tauri-apps/api/app", () => ({
  onBackButtonPress: (handler: () => void) => {
    appApiMock.onBackButtonPress(handler);
    return Promise.resolve({ unregister: appApiMock.unregister });
  },
}));

const platformMock = vi.hoisted(() => ({ IS_MOBILE: false }));
vi.mock("../utils/platform", () => ({
  get IS_MOBILE() {
    return platformMock.IS_MOBILE;
  },
}));

// The handler stack is module-level (single per page load, like the old
// adr_drplay implementation). Every test unmounts its hooks so cleanup
// removes handlers, and the empty-stack baseline is asserted after each test
// to prove no cross-test leakage.

afterEach(() => {
  cleanup();
  expect(handleGlobalBack()).toBe(false);
});

describe("useHardwareBack handler stack (LIFO)", () => {
  it("returns false on an empty stack", () => {
    expect(handleGlobalBack()).toBe(false);
  });

  it("runs the single active handler and returns true", () => {
    const fn = vi.fn(() => true);
    renderHook(() => {
      useHardwareBack(fn, true);
    });

    expect(handleGlobalBack()).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("runs the most recently registered handler first (LIFO) and stops at the first true", () => {
    const order: string[] = [];
    const first = vi.fn(() => {
      order.push("first");
      return true;
    });
    const second = vi.fn(() => {
      order.push("second");
      return true;
    });
    renderHook(() => {
      useHardwareBack(first, true);
    });
    renderHook(() => {
      useHardwareBack(second, true);
    });

    expect(handleGlobalBack()).toBe(true);
    expect(order).toEqual(["second"]);
    expect(first).not.toHaveBeenCalled();
  });

  it("keeps descending the stack when the newest handler returns false", () => {
    const order: string[] = [];
    const first = vi.fn(() => {
      order.push("first");
      return true;
    });
    const second = vi.fn(() => {
      order.push("second");
      return false;
    });
    renderHook(() => {
      useHardwareBack(first, true);
    });
    renderHook(() => {
      useHardwareBack(second, true);
    });

    expect(handleGlobalBack()).toBe(true);
    expect(order).toEqual(["second", "first"]);
  });

  it("does not register an inactive handler", () => {
    const fn = vi.fn(() => true);
    renderHook(() => {
      useHardwareBack(fn, false);
    });

    expect(handleGlobalBack()).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it("unregisters the handler on unmount", () => {
    const fn = vi.fn(() => true);
    const { unmount } = renderHook(() => {
      useHardwareBack(fn, true);
    });
    expect(handleGlobalBack()).toBe(true);

    unmount();

    expect(handleGlobalBack()).toBe(false);
  });

  it("unregisters the handler when isActive flips to false", () => {
    const fn = vi.fn(() => true);
    const { rerender } = renderHook(
      (props: { active: boolean }) => {
        useHardwareBack(fn, props.active);
      },
      { initialProps: { active: true } },
    );
    expect(handleGlobalBack()).toBe(true);

    rerender({ active: false });

    expect(handleGlobalBack()).toBe(false);
  });
});

// Task 9 mobile-polish: Android "Press back again to exit" convention — the
// first back press at the root shows a hint and arms a 2s window; a second
// press inside the window exits. Fake timers drive the window expiry.
describe("createDoubleBackExit (double-back-to-exit, 2s window)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("first back arms the window: hint callback fires, exit does not", () => {
    const onArm = vi.fn();
    const onExit = vi.fn();
    const { handleBack } = createDoubleBackExit({
      windowMs: DOUBLE_BACK_EXIT_MS,
      onArm,
      onExit,
    });

    expect(handleBack()).toBe(true);
    expect(onArm).toHaveBeenCalledTimes(1);
    expect(onExit).not.toHaveBeenCalled();
  });

  it("second back inside the window exits and consumes the press (no re-arm)", () => {
    const onArm = vi.fn();
    const onExit = vi.fn();
    const { handleBack } = createDoubleBackExit({
      windowMs: DOUBLE_BACK_EXIT_MS,
      onArm,
      onExit,
    });

    handleBack();
    vi.advanceTimersByTime(1000);
    expect(handleBack()).toBe(false);
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onArm).toHaveBeenCalledTimes(1);
  });

  it("expired window resets: the next back arms again instead of exiting", () => {
    const onArm = vi.fn();
    const onExit = vi.fn();
    const { handleBack } = createDoubleBackExit({
      windowMs: DOUBLE_BACK_EXIT_MS,
      onArm,
      onExit,
    });

    handleBack();
    vi.advanceTimersByTime(DOUBLE_BACK_EXIT_MS);
    expect(handleBack()).toBe(true);
    expect(onArm).toHaveBeenCalledTimes(2);
    expect(onExit).not.toHaveBeenCalled();
  });

  it("disarm clears the armed window (unmount/cleanup path — no leak)", () => {
    const onArm = vi.fn();
    const onExit = vi.fn();
    const { handleBack, disarm } = createDoubleBackExit({
      windowMs: DOUBLE_BACK_EXIT_MS,
      onArm,
      onExit,
    });

    handleBack();
    disarm();
    vi.advanceTimersByTime(DOUBLE_BACK_EXIT_MS * 2);
    expect(handleBack()).toBe(true);
    expect(onArm).toHaveBeenCalledTimes(2);
    expect(onExit).not.toHaveBeenCalled();
  });
});

// Task 9 mobile-polish upgrade: the Android hardware back button is wired to
// Tauri's official onBackButtonPress event (2.9+) instead of the popstate
// hack. The subscriber must (a) only touch the native API on mobile, (b) fire
// the provided handler on a back press, and (c) tear the native listener down
// on cleanup — including the async race where unregister() is called before
// the register promise resolves.
describe("registerNativeBackHandler (Android native back event)", () => {
  beforeEach(() => {
    appApiMock.onBackButtonPress.mockClear();
    appApiMock.unregister.mockClear();
  });

  afterEach(() => {
    platformMock.IS_MOBILE = false;
  });

  it("is a no-op on desktop: never calls the Tauri API", () => {
    platformMock.IS_MOBILE = false;
    const unregister = registerNativeBackHandler(() => {});
    unregister();
    expect(appApiMock.onBackButtonPress).not.toHaveBeenCalled();
  });

  it("registers onBackButtonPress on mobile and forwards presses to the handler", async () => {
    platformMock.IS_MOBILE = true;
    const handler = vi.fn();
    registerNativeBackHandler(handler);

    expect(appApiMock.onBackButtonPress).toHaveBeenCalledTimes(1);
    const nativeCb = appApiMock.onBackButtonPress.mock.calls[0]?.[0] as
      ((payload: { canGoBack: boolean }) => void) | undefined;
    expect(nativeCb).toBeTypeOf("function");
    await Promise.resolve();
    nativeCb?.({ canGoBack: false });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("unregisters the native listener on cleanup (after register resolves)", async () => {
    platformMock.IS_MOBILE = true;
    const unregister = registerNativeBackHandler(() => {});
    await Promise.resolve();
    unregister();
    expect(appApiMock.unregister).toHaveBeenCalledTimes(1);
  });

  it("handles cleanup BEFORE the register promise resolves (no native listener leak)", async () => {
    platformMock.IS_MOBILE = true;
    const unregister = registerNativeBackHandler(() => {});
    unregister();
    await Promise.resolve();
    expect(appApiMock.unregister).toHaveBeenCalledTimes(1);
  });
});
