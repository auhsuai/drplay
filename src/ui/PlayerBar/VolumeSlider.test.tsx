// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VolumeSlider } from "./VolumeSlider";
import type { PlaybackEngine } from "../../lib/nativeAudioBridge";

const { singletonToggleMute } = vi.hoisted(() => ({
  singletonToggleMute: vi.fn(() => false),
}));

vi.mock("../../lib/AudioController", () => ({
  AudioController: { getInstance: () => ({ toggleMute: singletonToggleMute }) },
}));

function makeAudio() {
  const toggleMute = vi.fn(() => false);
  const audio: PlaybackEngine = {
    on: vi.fn(() => () => {
      return undefined;
    }),
    playTrack: vi.fn(),
    pause: vi.fn(),
    togglePlay: vi.fn(),
    seek: vi.fn(),
    getCurrentTime: vi.fn(() => 0),
    getDuration: vi.fn(() => 0),
    getBuffered: vi.fn(() => ({
      duration: 0,
      currentTime: 0,
      buffered: { length: 0, start: () => 0, end: () => 0 },
    })),
    setVolume: vi.fn(),
    toggleMute,
    getVolume: vi.fn(() => 1),
    isMuted: vi.fn(() => false),
    release: vi.fn(),
  };
  return { audio, toggleMute };
}

afterEach(() => {
  cleanup();
});

describe("VolumeSlider", () => {
  it("toggles mute through the audio prop, not the AudioController singleton", () => {
    const { audio, toggleMute } = makeAudio();
    const { container } = render(<VolumeSlider audio={audio} />);
    const icon = container.querySelector("svg");
    expect(icon).not.toBeNull();
    fireEvent.click(icon as SVGSVGElement);
    expect(toggleMute).toHaveBeenCalledTimes(1);
    expect(singletonToggleMute).not.toHaveBeenCalled();
  });

  it("resets drag state and removes window listeners on pointercancel", () => {
    const { audio } = makeAudio();
    const { container } = render(<VolumeSlider audio={audio} />);
    const bar = container.querySelector(".cursor-pointer.relative");
    expect(bar).not.toBeNull();
    fireEvent.pointerDown(bar as HTMLDivElement, {
      clientX: 100,
      pointerId: 1,
    });
    const fill = container.querySelector("div.absolute.left-0");
    expect(fill).not.toBeNull();
    expect((fill as HTMLDivElement).className).toContain("!bg-brand-primary");

    const removeSpy = vi.spyOn(window, "removeEventListener");
    fireEvent.pointerCancel(window, { pointerId: 1 });

    expect((fill as HTMLDivElement).className).not.toContain(
      "!bg-brand-primary",
    );
    expect(removeSpy).toHaveBeenCalledWith(
      "pointercancel",
      expect.any(Function),
    );
    expect(removeSpy).toHaveBeenCalledWith("pointermove", expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith("pointerup", expect.any(Function));
    removeSpy.mockRestore();
  });
});
