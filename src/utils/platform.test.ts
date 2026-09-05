import { afterEach, describe, expect, it, vi } from "vitest";

// Minimal navigator shape for platform detection. Extra Navigator members are
// intentionally omitted — vi.stubGlobal replaces the whole global, and
// src/utils/platform.ts reads only these keys via narrowing (no `as any`).
interface NavigatorStub {
  readonly userAgent: string;
  readonly platform?: string;
  readonly maxTouchPoints?: number;
  readonly userAgentData?: {
    readonly platform?: string;
    readonly mobile?: boolean;
  };
}

// IS_MOBILE is a module-level constant, so each case re-imports a fresh copy
// after stubbing the navigator it will be evaluated against.
async function loadIsMobile(nav: NavigatorStub): Promise<boolean> {
  vi.resetModules();
  vi.stubGlobal("navigator", nav);
  const mod = await import("./platform");
  return mod.IS_MOBILE;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

// Real-world UA strings (iPadOS 13+ Safari reports a Macintosh UA with a
// Mobile token and no iPad token — Apple Developer Forums thread 119186).
const IPADOS_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const MAC_DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 " +
  "Safari/604.1";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36";
const WINDOWS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

describe("platform IS_MOBILE", () => {
  it("treats iPadOS desktop-class UA (Macintosh + Mobile + touch) as mobile", async () => {
    await expect(
      loadIsMobile({
        userAgent: IPADOS_UA,
        platform: "MacIntel",
        maxTouchPoints: 5,
      }),
    ).resolves.toBe(true);
  });

  it("keeps Mac desktop (no Mobile token, no touch) as desktop", async () => {
    await expect(
      loadIsMobile({
        userAgent: MAC_DESKTOP_UA,
        platform: "MacIntel",
        maxTouchPoints: 0,
      }),
    ).resolves.toBe(false);
  });

  it("keeps iPhone as mobile", async () => {
    await expect(
      loadIsMobile({
        userAgent: IPHONE_UA,
        platform: "iPhone",
        maxTouchPoints: 5,
      }),
    ).resolves.toBe(true);
  });

  it("keeps Android as mobile", async () => {
    await expect(
      loadIsMobile({
        userAgent: ANDROID_UA,
        platform: "Linux armv8l",
        maxTouchPoints: 5,
      }),
    ).resolves.toBe(true);
  });

  it("keeps Windows desktop (even with a touchscreen) as desktop", async () => {
    await expect(
      loadIsMobile({
        userAgent: WINDOWS_UA,
        platform: "Win32",
        maxTouchPoints: 10,
      }),
    ).resolves.toBe(false);
  });

  it("honours the userAgentData.mobile hint when present", async () => {
    await expect(
      loadIsMobile({
        userAgent: MAC_DESKTOP_UA,
        platform: "MacIntel",
        maxTouchPoints: 0,
        userAgentData: { platform: "iOS", mobile: true },
      }),
    ).resolves.toBe(true);
  });
});
