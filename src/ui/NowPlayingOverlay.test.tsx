// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// jsdom has no Element.animate: record every WAAPI call and hand the overlay a
// cancellable stub, so the effect's cancel/restart wiring is observable.
type AnimationStub = {
  cancel: ReturnType<typeof vi.fn>;
  onfinish: (() => void) | null;
  oncancel: (() => void) | null;
};

let animateMock: ReturnType<typeof vi.fn>;
let animations: AnimationStub[];
const originalAnimate = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "animate",
);

beforeEach(() => {
  animations = [];
  animateMock = vi.fn(() => {
    const animation: AnimationStub = {
      cancel: vi.fn(),
      onfinish: null,
      oncancel: null,
    };
    animations.push(animation);
    return animation;
  });
  Element.prototype.animate = animateMock as unknown as Element["animate"];
});

afterEach(() => {
  if (originalAnimate) {
    Object.defineProperty(Element.prototype, "animate", originalAnimate);
  } else {
    delete (Element.prototype as { animate?: unknown }).animate;
  }
  cleanup();
  vi.unstubAllGlobals();
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
// Collapse / expand. The slide is the ONE motion of this transition and it is
// driven by the Web Animations API: the CSS `transition-[translate]` entering
// transition proved unreliable in WebView2 (the class flip and the first paint
// could coalesce, so opening appeared instantly). The animation is explicit, so
// it always runs. The shell is `fixed`, so it never reserves layout space —
// "no leftover empty layout space" is a property of the markup, not a cleanup
// timer.
// ---------------------------------------------------------------------------
describe("collapse/expand transition (Web Animations API)", () => {
  type AnimateCall = [Keyframe[], KeyframeAnimationOptions];

  function firstCall(): AnimateCall {
    const call = (animateMock.mock.calls as unknown as AnimateCall[])[0];
    if (!call) throw new Error("Element.animate was not called");
    return call;
  }

  function shellClass(isOpen: boolean): string {
    const { container, unmount } = render(
      <NowPlayingOverlay {...baseProps()} isOpen={isOpen} />,
    );
    const className = (container.firstElementChild as HTMLElement).className;
    unmount();
    return className;
  }

  it("open animates from off-screen to rest with the opening curve", () => {
    const { rerender } = render(<NowPlayingOverlay {...baseProps()} />);
    rerender(<NowPlayingOverlay {...baseProps()} isOpen />);

    expect(animateMock).toHaveBeenCalledTimes(1);
    const [keyframes, options] = firstCall();
    expect(keyframes).toEqual([{ translate: "0 100%" }, { translate: "0 0" }]);
    expect(options).toMatchObject({
      duration: 280,
      easing: "cubic-bezier(0.4, 0, 0.2, 1)",
      fill: "both",
    });
  });

  it("close animates from rest to off-screen with the closing curve", () => {
    const { rerender } = render(<NowPlayingOverlay {...baseProps()} isOpen />);
    rerender(<NowPlayingOverlay {...baseProps()} />);

    expect(animateMock).toHaveBeenCalledTimes(1);
    const [keyframes, options] = firstCall();
    expect(keyframes).toEqual([{ translate: "0 0" }, { translate: "0 100%" }]);
    expect(options).toMatchObject({
      duration: 280,
      easing: "cubic-bezier(0.4, 0, 1, 1)",
      fill: "both",
    });
  });

  it("resting classes own both end states; no CSS transition classes remain", () => {
    const open = shellClass(true).split(/\s+/);
    const closed = shellClass(false).split(/\s+/);

    expect(open).toContain("translate-y-0");
    expect(open).not.toContain("pointer-events-none");
    expect(closed).toContain("translate-y-full");
    expect(closed).toContain("pointer-events-none");

    for (const cls of [open, closed]) {
      expect(cls).not.toContain("transition-[translate]");
      expect(cls).not.toContain("transition-transform");
      expect(cls).not.toContain("transition-all");
      expect(cls).not.toContain("duration-[280ms]");
      expect(cls).not.toContain("ease-in-out");
      expect(cls).not.toContain("ease-in");
      expect(cls).not.toContain("motion-reduce:transition-none");
      // Opacity/geometry must NOT be part of the same motion.
      expect(cls).not.toContain("opacity-0");
      expect(cls).not.toContain("scale-");
    }
  });

  it("rapid open → close cancels the in-flight animation and starts a new one", () => {
    const { rerender } = render(<NowPlayingOverlay {...baseProps()} />);
    rerender(<NowPlayingOverlay {...baseProps()} isOpen />);
    expect(animations).toHaveLength(1);

    rerender(<NowPlayingOverlay {...baseProps()} />);

    const firstAnimation = animations[0];
    if (!firstAnimation) throw new Error("no animation was started");
    expect(firstAnimation.cancel).toHaveBeenCalledTimes(1);
    expect(animateMock).toHaveBeenCalledTimes(2);
  });

  it("reduced motion: no animation, resting classes still correct", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));

    const { container, rerender } = render(
      <NowPlayingOverlay {...baseProps()} />,
    );
    rerender(<NowPlayingOverlay {...baseProps()} isOpen />);

    expect(animateMock).not.toHaveBeenCalled();
    expect((container.firstElementChild as HTMLElement).className).toContain(
      "translate-y-0",
    );
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
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");

    const { container, rerender, unmount } = render(
      <NowPlayingOverlay {...baseProps()} isOpen />,
    );
    const shell = () => container.firstElementChild as HTMLElement;
    const openClass = shell().className;

    for (let cycle = 0; cycle < 3; cycle += 1) {
      rerender(<NowPlayingOverlay {...baseProps()} />);
      rerender(<NowPlayingOverlay {...baseProps()} isOpen />);
      expect(shell().className).toBe(openClass);
    }

    // One animation per transition, no timers, no accumulated listeners.
    expect(animateMock).toHaveBeenCalledTimes(6);
    expect(addSpy.mock.calls.length).toBe(removeSpy.mock.calls.length);

    rerender(<NowPlayingOverlay {...baseProps()} />);
    expect(shell().className).toBe(shellClass(false));

    const lastAnimation = animations[animations.length - 1];
    if (!lastAnimation) throw new Error("no animation was started");
    unmount();
    expect(lastAnimation.cancel).toHaveBeenCalled();

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});
