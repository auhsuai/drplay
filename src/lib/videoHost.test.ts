import { beforeEach, describe, expect, it, vi } from "vitest";

const tauriMocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriMocks.invoke }));
vi.mock("../utils/errorLog", () => ({ captureError: vi.fn() }));

import {
  sameRect,
  setVideoHostRect,
  setVideoHostVisible,
  shouldShowVideoHost,
  toPhysicalRect,
  VIDEO_HOST_COMMANDS,
} from "./videoHost";

function calls(name: string): Array<Record<string, unknown>> {
  return (
    tauriMocks.invoke.mock.calls as unknown as Array<
      [string, Record<string, unknown>]
    >
  )
    .filter((call) => call[0] === name)
    .map((call) => call[1]);
}

beforeEach(() => {
  tauriMocks.invoke.mockReset();
  tauriMocks.invoke.mockResolvedValue(1);
});

describe("toPhysicalRect — CSS px -> physical px", () => {
  it("800x450 CSS at dpr 1.5 → x=150 y=375 w=1200 h=675 (worked example)", () => {
    expect(
      toPhysicalRect({ left: 100, top: 250, width: 800, height: 450 }, 1.5),
    ).toEqual({ x: 150, y: 375, w: 1200, h: 675 });
  });

  it("dpr 1 leaves the CSS values untouched", () => {
    expect(
      toPhysicalRect({ left: 12, top: 34, width: 640, height: 360 }, 1),
    ).toEqual({ x: 12, y: 34, w: 640, h: 360 });
  });

  it("a collapsed box (minimized window) never becomes a rect", () => {
    expect(
      toPhysicalRect({ left: 0, top: 0, width: 0, height: 0 }, 1.5),
    ).toBeNull();
    expect(
      toPhysicalRect({ left: 10, top: 20, width: -5, height: 100 }, 1.5),
    ).toBeNull();
    expect(
      toPhysicalRect({ left: 10, top: 20, width: 100, height: -1 }, 1.5),
    ).toBeNull();
  });

  it("a sub-pixel box that rounds to zero width is dropped, not sent as 0", () => {
    expect(
      toPhysicalRect({ left: 0, top: 0, width: 0.2, height: 10 }, 1),
    ).toBeNull();
  });

  it("a non-finite ratio or rect is dropped (never NaN reaches Rust)", () => {
    expect(
      toPhysicalRect({ left: 0, top: 0, width: 10, height: 10 }, Number.NaN),
    ).toBeNull();
    expect(
      toPhysicalRect({ left: 0, top: 0, width: 10, height: 10 }, 0),
    ).toBeNull();
    expect(
      toPhysicalRect({ left: Number.NaN, top: 0, width: 10, height: 10 }, 1.5),
    ).toBeNull();
  });
});

describe("sameRect — the no-invoke-spam guard", () => {
  it("equal rects match; any difference does not; null never matches", () => {
    const rect = { x: 1, y: 2, w: 3, h: 4 };
    expect(sameRect(null, rect)).toBe(false);
    expect(sameRect({ ...rect }, rect)).toBe(true);
    expect(sameRect({ x: 1, y: 2, w: 3, h: 5 }, rect)).toBe(false);
  });
});

describe("shouldShowVideoHost — the whole visibility rule", () => {
  const shown = {
    hasTrack: true,
    isVideo: true,
    isOpen: true,
    isShellLocked: false,
    hasError: false,
    hasEnded: false,
  };

  const cases: Array<[string, Partial<typeof shown>, boolean]> = [
    ["video + overlay open + healthy -> shown", {}, true],
    ["no track -> hidden", { hasTrack: false }, false],
    ["audio track -> hidden", { isVideo: false }, false],
    ["overlay closed -> hidden", { isOpen: false }, false],
    ["shell locked by a modal -> hidden", { isShellLocked: true }, false],
    [
      "error -> hidden (native content cannot be covered)",
      { hasError: true },
      false,
    ],
    [
      "ended -> hidden (a frozen last frame must not keep looking live)",
      { hasEnded: true },
      false,
    ],
    ["audio + open -> hidden", { isVideo: false, hasError: false }, false],
    [
      "audio while shell locked -> hidden",
      { isVideo: false, isShellLocked: true },
      false,
    ],
  ];

  it.each(cases)("%s", (_label, patch, expected) => {
    expect(shouldShowVideoHost({ ...shown, ...patch })).toBe(expected);
  });

  it("video -> video (nothing else changed) stays shown: no hide/show churn", () => {
    expect(shouldShowVideoHost(shown)).toBe(shouldShowVideoHost({ ...shown }));
  });

  // Fullscreen is a REFINEMENT of the overlay, not a second surface: it never
  // adds a visibility term. Entering it must not change what shouldShowVideoHost
  // decides — the overlay being open is already the requirement.
  it("fullscreen does not change the rule: overlay open is still the only gate", () => {
    expect(shouldShowVideoHost(shown)).toBe(true);
    expect(shouldShowVideoHost({ ...shown, isOpen: false })).toBe(false);
  });
});

describe("acquire ordering primitive", () => {
  // The memo is module scope by design (one host per session), so each case
  // re-imports the module to start from a cold memo instead of inheriting the
  // previous test's handle.
  async function freshModule(): Promise<typeof import("./videoHost")> {
    vi.resetModules();
    return await import("./videoHost");
  }

  beforeEach(() => {
    tauriMocks.invoke.mockResolvedValue(1);
  });

  it("is memoized: concurrent callers share ONE invoke", async () => {
    const mod = await freshModule();
    const [a, b] = await Promise.all([
      mod.ensureVideoHostAcquired(),
      mod.ensureVideoHostAcquired(),
    ]);
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(calls(mod.VIDEO_HOST_COMMANDS.acquire)).toHaveLength(1);
  });

  it("resolves 0 and retries later when the host is unavailable", async () => {
    const mod = await freshModule();
    tauriMocks.invoke.mockResolvedValueOnce(0);
    expect(await mod.ensureVideoHostAcquired()).toBe(0);
    expect(await mod.ensureVideoHostAcquired()).toBe(1);
    expect(calls(mod.VIDEO_HOST_COMMANDS.acquire)).toHaveLength(2);
  });

  it("a rejected acquire degrades to 0 (never throws into playback)", async () => {
    const mod = await freshModule();
    tauriMocks.invoke.mockRejectedValueOnce(new Error("no window"));
    expect(await mod.ensureVideoHostAcquired()).toBe(0);
  });
});

describe("set_rect / set_visible payloads", () => {
  it("sends flat x/y/w/h physical px and a bare visible flag", () => {
    setVideoHostRect({ x: 150, y: 375, w: 1200, h: 675 });
    setVideoHostVisible(true);

    expect(calls(VIDEO_HOST_COMMANDS.setRect)).toEqual([
      { x: 150, y: 375, w: 1200, h: 675 },
    ]);
    expect(calls(VIDEO_HOST_COMMANDS.setVisible)).toEqual([{ visible: true }]);
  });
});
