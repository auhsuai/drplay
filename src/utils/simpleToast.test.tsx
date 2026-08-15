// @vitest-environment jsdom
// Unit tests for simpleToast: className variant contract (mirrors what
// SettingsTab.toast.test.tsx asserts for the success branch), duration
// clamping (0/negative must not crash and must remove the toast fast).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { showErrorToast, showSuccessToast } from "./simpleToast";

describe("simpleToast", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="content-area"></div>';
    vi.useFakeTimers();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("showErrorToast appends a .app-toast--error element with the message", () => {
    showErrorToast("boom");

    const el = document.querySelector<HTMLElement>(".app-toast--error");
    expect(el).not.toBeNull();
    expect(el?.className).toBe(
      "app-toast app-toast--error max-w-[85vw] break-words line-clamp-3",
    );
    expect(el?.textContent).toBe("boom");
    expect(document.querySelector(".app-toast--success")).toBeNull();
  });

  it("showSuccessToast appends a .app-toast--success element with the message", () => {
    showSuccessToast("ok");

    const el = document.querySelector(".app-toast--success");
    expect(el).not.toBeNull();
    expect(el?.className).toBe(
      "app-toast app-toast--success max-w-[85vw] break-words line-clamp-3",
    );
    expect(el?.textContent).toBe("ok");
    expect(document.querySelector(".app-toast--error")).toBeNull();
  });

  it("BUG regression: a very long message is clamped/wrapped, never raw-overflowing the screen", () => {
    // jsdom cannot measure real layout — the contract is asserted on the
    // classes that carry the clamp (max-width + word-wrap + 3-line clamp)
    // plus the full message kept in title for tooltip/accessibility.
    const longMessage = "x".repeat(500);
    showErrorToast(longMessage);

    const el = document.querySelector<HTMLElement>(".app-toast--error");
    expect(el).not.toBeNull();
    const className = el?.className ?? "";
    expect(className).toContain("max-w-[85vw]");
    expect(className).toContain("break-words");
    expect(className).toContain("line-clamp-3");
    expect(el?.title).toBe(longMessage);
    expect(el?.textContent).toBe(longMessage);
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
    expect(() => {
      showErrorToast("boom", { duration: 0 });
    }).not.toThrow();

    vi.advanceTimersByTime(200);
    expect(document.querySelector(".app-toast")).toBeNull();
  });

  it("negative duration does not crash and the toast disappears", () => {
    expect(() => {
      showErrorToast("boom", { duration: -500 });
    }).not.toThrow();

    vi.advanceTimersByTime(200);
    expect(document.querySelector(".app-toast")).toBeNull();
  });

  it("second toast replaces the first immediately (only one .app-toast in DOM)", () => {
    showErrorToast("A");
    showErrorToast("B");

    expect(document.querySelectorAll(".app-toast").length).toBe(1);
    expect(document.querySelector(".app-toast")?.textContent).toBe("B");
  });

  it("replacing a toast does not inherit the old toast's timer", () => {
    showErrorToast("A");
    vi.advanceTimersByTime(100);
    showErrorToast("B");

    // A (4000ms) would have started fading at t=4000: B must still be alive.
    vi.advanceTimersByTime(3900);
    expect(document.querySelector(".app-toast")?.textContent).toBe("B");
    // A would have been removed at t=4200: still no early removal of B.
    vi.advanceTimersByTime(200);
    expect(document.querySelector(".app-toast")?.textContent).toBe("B");
    // B's own lifecycle: 4000ms (from B's show at t=100) + 200ms fade.
    vi.advanceTimersByTime(100);
    expect(document.querySelector(".app-toast")).toBeNull();
  });

  it("after a toast expires naturally, the next toast works", () => {
    showErrorToast("A");
    vi.advanceTimersByTime(4200);
    expect(document.querySelector(".app-toast")).toBeNull();

    showErrorToast("B");
    expect(document.querySelector(".app-toast")?.textContent).toBe("B");
    vi.advanceTimersByTime(4200);
    expect(document.querySelector(".app-toast")).toBeNull();
  });
});
