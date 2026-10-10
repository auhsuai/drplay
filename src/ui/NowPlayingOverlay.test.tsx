// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NowPlayingOverlay } from "./NowPlayingOverlay";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// The view drags AudioController/store/metadata fetching — out of scope here.
vi.mock("./NowPlaying/NowPlayingView", () => ({
  NowPlayingView: () => <div data-testid="now-playing-view-stub" />,
}));

function baseProps() {
  return {
    isOpen: false,
    currentTrack: null,
    isPlaying: false,
    onTogglePlay: vi.fn(),
    onNextTrack: vi.fn(),
    onPrevTrack: vi.fn(),
    playMode: "normal" as const,
    onTogglePlayMode: vi.fn(),
    onBack: vi.fn(),
    token: null,
    isShellLocked: false,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("NowPlayingOverlay closed-state a11y contract (P2-12-2)", () => {
  it("closed → shell aria-hidden + inert + pointer-events-none (vẫn mount cho transition)", () => {
    const { container } = render(<NowPlayingOverlay {...baseProps()} />);
    const shell = container.firstElementChild as HTMLElement;

    expect(shell.getAttribute("aria-hidden")).toBe("true");
    expect(shell.hasAttribute("inert")).toBe(true);
    expect(shell.className).toContain("translate-y-full");
    expect(shell.className).toContain("pointer-events-none");
    // Exit animation contract: the shell is NOT unmounted when closed.
    expect(
      container.querySelector('[data-testid="now-playing-view-stub"]'),
    ).not.toBeNull();
  });

  it("open → shell visible, aria-hidden/inert bị gỡ", () => {
    const { container } = render(<NowPlayingOverlay {...baseProps()} isOpen />);
    const shell = container.firstElementChild as HTMLElement;

    expect(shell.getAttribute("aria-hidden")).toBe("false");
    expect(shell.hasAttribute("inert")).toBe(false);
    expect(shell.className).toContain("translate-y-0");
    expect(shell.className).not.toContain("pointer-events-none");
  });
});

// ---------------------------------------------------------------------------
// Collapse / expand. The slide is the ONE motion of this transition, it must be
// short and restrained, and it must not animate geometry, opacity or anything
// else at the same time. The shell is `fixed`, so it never reserves layout
// space — that is what makes "no leftover empty layout space" a property of the
// markup rather than of a cleanup timer.
// ---------------------------------------------------------------------------
describe("collapse/expand transition", () => {
  function shellClass(isOpen: boolean): string {
    const { container, unmount } = render(
      <NowPlayingOverlay {...baseProps()} isOpen={isOpen} />,
    );
    const className = (container.firstElementChild as HTMLElement).className;
    unmount();
    return className;
  }

  it("animates ONLY the slide, and only the `translate` property", () => {
    const cls = shellClass(false);

    // Tailwind v4's `transition-transform` expands to
    // `transition-property: transform, translate, scale, rotate`; the slide only
    // ever changes `translate`, so the transition is narrowed to that one
    // property instead of the whole group.
    expect(cls).toContain("transition-[translate]");
    expect(cls).not.toContain("transition-transform");
    expect(cls).not.toContain("transition-all");
    // Opacity/geometry must NOT be part of the same motion.
    expect(cls).not.toContain("opacity-0");
    expect(cls).not.toContain("scale-");
  });

  it("is short and restrained (180-250ms) and honours reduced motion", () => {
    const cls = shellClass(false);

    expect(cls).toContain("duration-200");
    expect(cls).not.toContain("duration-500");
    expect(cls).toContain("ease-out");
    expect(cls).toContain("motion-reduce:transition-none");
  });

  it("closed: the final state is off-screen, inert and out of flow (no leftover layout space)", () => {
    const { container } = render(<NowPlayingOverlay {...baseProps()} />);
    const shell = container.firstElementChild as HTMLElement;

    expect(shell.className).toContain("fixed");
    expect(shell.className).toContain("inset-0");
    expect(shell.className).toContain("translate-y-full");
    expect(shell.className).toContain("pointer-events-none");
    // Still mounted, so the exit animation is observable at all.
    expect(
      container.querySelector('[data-testid="now-playing-view-stub"]'),
    ).not.toBeNull();
  });

  it("three collapse/expand cycles end in the identical state and leak nothing", () => {
    vi.useFakeTimers();
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");

    const { container, rerender } = render(
      <NowPlayingOverlay {...baseProps()} isOpen />,
    );
    const shell = () => container.firstElementChild as HTMLElement;
    const openClass = shell().className;

    for (let cycle = 0; cycle < 3; cycle += 1) {
      rerender(<NowPlayingOverlay {...baseProps()} />);
      vi.advanceTimersByTime(1000);
      rerender(<NowPlayingOverlay {...baseProps()} isOpen />);
      vi.advanceTimersByTime(1000);
      expect(shell().className).toBe(openClass);
    }

    // No stuck intermediate state, no timers and no listeners accumulated by
    // the repeated transitions.
    expect(vi.getTimerCount()).toBe(0);
    expect(addSpy.mock.calls.length).toBe(removeSpy.mock.calls.length);

    rerender(<NowPlayingOverlay {...baseProps()} />);
    vi.advanceTimersByTime(1000);
    expect(shell().className).toBe(shellClass(false));
  });
});
