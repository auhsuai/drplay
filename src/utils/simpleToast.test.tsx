// @vitest-environment jsdom
// Unit tests for simpleToast: className variant contract (mirrors what
// SettingsTab.toast.test.tsx asserts for the success branch), duration
// clamping (0/negative must not crash and must remove the toast fast).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { showErrorToast, showSuccessToast } from "./simpleToast";

describe("simpleToast", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="toast-root"></div>';
    vi.useFakeTimers();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("showErrorToast appends a .app-toast--error element with the message", () => {
    showErrorToast("boom");

    const el = document.querySelector(
      ".app-toast--error",
    ) as HTMLElement | null;
    expect(el).not.toBeNull();
    expect(el?.className).toBe("app-toast app-toast--error");
    expect(el?.textContent).toBe("boom");
    expect(document.querySelector(".app-toast--success")).toBeNull();
  });

  it("showSuccessToast appends a .app-toast--success element with the message", () => {
    showSuccessToast("ok");

    const el = document.querySelector(
      ".app-toast--success",
    ) as HTMLElement | null;
    expect(el).not.toBeNull();
    expect(el?.className).toBe("app-toast app-toast--success");
    expect(el?.textContent).toBe("ok");
    expect(document.querySelector(".app-toast--error")).toBeNull();
  });

  it("removes the toast after default duration (4000ms) + fade-out (200ms)", () => {
    showErrorToast("boom");

    vi.advanceTimersByTime(4000);
    expect(document.querySelector(".app-toast")).not.toBeNull();
    vi.advanceTimersByTime(200);
    expect(document.querySelector(".app-toast")).toBeNull();
  });

  it("honors a duration override", () => {
    showSuccessToast("ok", { duration: 100 });

    vi.advanceTimersByTime(99);
    expect(document.querySelector(".app-toast")).not.toBeNull();
    vi.advanceTimersByTime(1 + 200);
    expect(document.querySelector(".app-toast")).toBeNull();
  });

  it("duration 0 removes the toast quickly without crash", () => {
    expect(() => showErrorToast("boom", { duration: 0 })).not.toThrow();

    vi.advanceTimersByTime(200);
    expect(document.querySelector(".app-toast")).toBeNull();
  });

  it("negative duration does not crash and the toast disappears", () => {
    expect(() => showErrorToast("boom", { duration: -500 })).not.toThrow();

    vi.advanceTimersByTime(200);
    expect(document.querySelector(".app-toast")).toBeNull();
  });
});
