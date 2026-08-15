// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureError } from "./errorLog";
import { LS_SIDEBAR_OPEN, loadSidebarOpenState } from "./sidebarState";

vi.mock("./errorLog", () => ({
  captureError: vi.fn().mockResolvedValue(undefined),
}));

// Module-level mock: sidebarState reads IS_MOBILE at call time; a constant
// mock is safe here (this file never flips it mid-suite). Mirror of the
// desktop suite in sidebarState.test.ts (which runs with the real platform
// module — jsdom UA has no mobile keywords, so IS_MOBILE=false there).
vi.mock("./platform", () => ({ IS_MOBILE: true }));

const mockedCaptureError = vi.mocked(captureError);

// Task 9 follow-up: on mobile the sidebar defaults to CLOSED on first launch.
// Before this, default-open made the hardware-back sidebar handler register
// on mount and silently swallow the FIRST back press (it collapsed the
// invisible sidebar), so users needed two presses to reach the exit toast.
// Stored values stay respected — only the no-key default is platform-aware.
describe("sidebarState (mobile)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("defaults to closed (false) on mobile when no key is stored — first back press reaches the exit toast", () => {
    expect(loadSidebarOpenState()).toBe(false);
  });

  it("returns false when the stored value is exactly 'false'", () => {
    localStorage.setItem(LS_SIDEBAR_OPEN, "false");
    expect(loadSidebarOpenState()).toBe(false);
  });

  it("returns true when the stored value is 'true' (user explicitly opened)", () => {
    localStorage.setItem(LS_SIDEBAR_OPEN, "true");
    expect(loadSidebarOpenState()).toBe(true);
  });

  it("SecurityError from localStorage.getItem is caught → falls back to closed (false) on mobile and logs", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    expect(loadSidebarOpenState()).toBe(false);
    expect(mockedCaptureError).toHaveBeenCalledWith({
      level: "warn",
      source: "sidebarState",
      message: "sidebar-open-read-failed:SecurityError",
    });
  });
});
