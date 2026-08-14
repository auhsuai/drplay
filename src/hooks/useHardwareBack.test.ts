// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleGlobalBack, useHardwareBack } from "./useHardwareBack";

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
