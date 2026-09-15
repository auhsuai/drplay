// @vitest-environment jsdom
// B20-3 wiring guard: the stored theme class must already be on <html> by the
// time createRoot is called — i.e. BEFORE React's first commit. The hook's
// useLayoutEffect only fires after commit, which lazy chunks/Suspense can
// delay long enough to paint a white background (App.css defaults to light).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Probe: captured from inside the mocked createRoot, so it records the class
// state at exactly the moment React would take over the root element.
const probe = vi.hoisted(() => ({
  classNameAtCreateRoot: null as string | null,
}));

vi.mock("react-dom/client", () => ({
  default: {
    createRoot: () => {
      probe.classNameAtCreateRoot = document.documentElement.className;
      return { render: () => {} };
    },
  },
}));

vi.mock("./App", () => ({ default: () => null }));

describe("theme bootstrap before createRoot (B20-3)", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("light", "dark");
    probe.classNameAtCreateRoot = null;
    if (document.getElementById("root") === null) {
      const rootEl = document.createElement("div");
      rootEl.id = "root";
      document.body.appendChild(rootEl);
    }
  });

  afterEach(() => {
    document.documentElement.classList.remove("light", "dark");
    localStorage.clear();
    document.getElementById("root")?.remove();
  });

  it("applies the stored dark theme class before createRoot runs", async () => {
    localStorage.setItem("drplay_theme", "dark");

    await import("./main");

    expect(probe.classNameAtCreateRoot).not.toBeNull();
    expect(probe.classNameAtCreateRoot).toContain("dark");
  });
});
