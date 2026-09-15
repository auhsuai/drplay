// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTheme } from "./useTheme";

// NOTE (B15-6): the FOUC itself (class applied before the first paint) is a
// timing property that jsdom cannot observe — these tests are the behavioral
// guard around the useLayoutEffect swap: the class MUST land on
// documentElement synchronously with the commit, on mount and on every
// theme/system change, and the media listener must detach on unmount.

type MediaListener = (event: MediaQueryListEvent) => void;

interface MediaQueryMock {
  listeners: Set<MediaListener>;
  setMatches: (value: boolean) => void;
}

// jsdom's matchMedia is a static stub (matches always false, no real change
// events) — install an observable stand-in with a programmable `matches` and a
// manual change broadcast.
function installMatchMedia(initialMatches: boolean): MediaQueryMock {
  const listeners = new Set<MediaListener>();
  let matches = initialMatches;
  const mql = {
    get matches() {
      return matches;
    },
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: (_type: string, handler: MediaListener) => {
      listeners.add(handler);
    },
    removeEventListener: (_type: string, handler: MediaListener) => {
      listeners.delete(handler);
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  };
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockReturnValue(mql),
  });
  return {
    listeners,
    setMatches: (value: boolean) => {
      matches = value;
      for (const listener of listeners) {
        listener({ matches: value } as MediaQueryListEvent);
      }
    },
  };
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("light", "dark");
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.classList.remove("light", "dark");
  // jsdom does not implement matchMedia here — drop the per-test stub instead
  // of restoring a captured method reference.
  Reflect.deleteProperty(window, "matchMedia");
});

describe("useTheme class application (B15-6 behavioral guard)", () => {
  it("applies the stored dark theme class on mount", () => {
    installMatchMedia(false);
    localStorage.setItem("drplay_theme", "dark");

    const { result } = renderHook(() => useTheme());

    expect(result.current.theme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.classList.contains("light")).toBe(false);
  });

  it("applies light when theme=system and the system preference is light", () => {
    installMatchMedia(false);
    renderHook(() => useTheme());
    expect(document.documentElement.classList.contains("light")).toBe(true);
  });

  it("applies dark when theme=system and the system preference is dark", () => {
    installMatchMedia(true);
    renderHook(() => useTheme());
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("changeTheme swaps the class on documentElement and persists to localStorage", () => {
    installMatchMedia(false);
    const { result } = renderHook(() => useTheme());

    act(() => {
      result.current.setTheme("dark");
    });
    expect(result.current.theme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.classList.contains("light")).toBe(false);
    expect(localStorage.getItem("drplay_theme")).toBe("dark");

    act(() => {
      result.current.setTheme("light");
    });
    expect(document.documentElement.classList.contains("light")).toBe(true);
    expect(localStorage.getItem("drplay_theme")).toBe("light");
  });

  it("system preference change re-applies the class only while theme=system", () => {
    const media = installMatchMedia(false);
    const { result } = renderHook(() => useTheme());
    expect(document.documentElement.classList.contains("light")).toBe(true);

    act(() => {
      media.setMatches(true);
    });
    expect(result.current.theme).toBe("system");
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    // Explicit theme: an OS preference flip must not override the user choice.
    act(() => {
      result.current.setTheme("light");
    });
    act(() => {
      media.setMatches(false);
    });
    expect(document.documentElement.classList.contains("light")).toBe(true);
  });

  it("removes the media listener on unmount", () => {
    const media = installMatchMedia(false);
    const { unmount } = renderHook(() => useTheme());
    expect(media.listeners.size).toBe(1);
    unmount();
    expect(media.listeners.size).toBe(0);
  });

  it("falls back to system when the stored theme value is invalid", () => {
    installMatchMedia(false);
    localStorage.setItem("drplay_theme", "neon");
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("system");
    expect(document.documentElement.classList.contains("light")).toBe(true);
  });
});
