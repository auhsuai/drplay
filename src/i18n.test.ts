// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./utils/errorLog", () => ({
  captureError: vi.fn().mockResolvedValue(undefined),
}));

// i18n.ts reads localStorage at MODULE SCOPE (before any render). A blocked
// storage (SecurityError — see MDN Window.localStorage) used to crash the app
// at import time; the guard must keep the module bootable.
describe("i18n module init (P0 crash guard)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  // Fresh module graph per scenario — module-scope init runs once per import.
  // captureError is re-read from the fresh graph so the spy matches the
  // instance i18n.ts actually called (vi.resetModules rebuilds mocks).
  async function freshI18n() {
    vi.resetModules();
    const mod = await import("./i18n");
    const { captureError } = await import("./utils/errorLog");
    return {
      default: mod.default,
      language: (mod.default as { language: string }).language,
      captureError: vi.mocked(captureError),
    };
  }

  it("boots with English when localStorage.getItem throws SecurityError — module import must not throw", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    const { default: i18nInstance, language, captureError } = await freshI18n();
    expect(i18nInstance).toBeDefined();
    expect(language).toBe("en");
    expect(captureError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        source: "i18n",
        message: expect.stringContaining(
          "i18n-language-read-failed",
        ) as unknown as string,
      }),
    );
  });

  it("uses the stored language when storage works", async () => {
    localStorage.setItem("drplay_language", "vi");

    const { language } = await freshI18n();
    expect(language).toBe("vi");
  });

  it("falls back to English for a corrupt stored value (supportedLngs guard)", async () => {
    localStorage.setItem("drplay_language", "garbage-language");

    const { language } = await freshI18n();
    expect(language).toBe("en");
  });

  it("logs a warn via captureError when t() hits a missing key (dev gate)", async () => {
    const { default: i18nInstance, captureError } = await freshI18n();

    // Runtime-only probe: the compile-time resource types now reject unknown
    // keys, so cast t to an untyped callable to simulate a stale/typo'd key
    // slipping past the type system (that is exactly what this handler is for).
    const tUntyped = i18nInstance.t.bind(i18nInstance) as (
      key: string,
    ) => string;
    tUntyped("nonexistent.key.xyz");

    expect(captureError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        source: "i18n",
        message: expect.stringContaining(
          "i18n-missing-key",
        ) as unknown as string,
      }),
    );
  });
});
