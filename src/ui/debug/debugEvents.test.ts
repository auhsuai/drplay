// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEBUG_EVENTS, dispatchDebugEvent } from "./debugEvents";

describe("debugEvents", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dispatches a CustomEvent with the exact RATE_LIMIT event name", () => {
    const spy = vi.spyOn(window, "dispatchEvent");

    dispatchDebugEvent(DEBUG_EVENTS.RATE_LIMIT, undefined);

    expect(spy).toHaveBeenCalledTimes(1);
    const event = spy.mock.calls[0]?.[0] as CustomEvent;
    expect(event.type).toBe(DEBUG_EVENTS.RATE_LIMIT);
  });

  it("wraps the detail object for PLAYER_ERROR unchanged", () => {
    const spy = vi.spyOn(window, "dispatchEvent");
    const detail = { code: "403", message: "rate limited" };

    dispatchDebugEvent(DEBUG_EVENTS.PLAYER_ERROR, detail);

    const event = spy.mock.calls[0]?.[0] as CustomEvent;
    expect(event.type).toBe(DEBUG_EVENTS.PLAYER_ERROR);
    expect(event.detail).toEqual(detail);
  });

  it("wraps QUOTA detail with usageInDrive and limit", () => {
    const spy = vi.spyOn(window, "dispatchEvent");

    dispatchDebugEvent(DEBUG_EVENTS.QUOTA, {
      usageInDrive: 123,
      limit: null,
    });

    const event = spy.mock.calls[0]?.[0] as CustomEvent;
    expect(event.detail).toEqual({ usageInDrive: 123, limit: null });
  });

  it("does not throw when there are no listeners", () => {
    expect(() => {
      dispatchDebugEvent(DEBUG_EVENTS.SKELETON, { target: "home" });
    }).not.toThrow();
  });
});
