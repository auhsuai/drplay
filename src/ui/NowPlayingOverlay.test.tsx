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
  };
}

afterEach(() => {
  cleanup();
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
