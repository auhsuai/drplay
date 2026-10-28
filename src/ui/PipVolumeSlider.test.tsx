// @vitest-environment jsdom
// Behavior contract for the PiP volume control (Slice 3/3).
//
// The PiP window has no audio engine, so this control is PRESENTATIONAL: it
// owns only the transient "is the finger down" state and reports every change
// upwards. The behaviours pinned here are the ones the shared PlayerBar
// VolumeSlider already guarantees (single-owner drag, no NaN on a zero-width
// rail, no listener leak when the window closes mid-drag) plus the a11y fix
// this copy deliberately does NOT inherit: the mute affordance is a real
// <button>, not an <svg onClick>.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PipVolumeSlider } from "./PipVolumeSlider";
import en from "../locales/en/translation.json";

vi.mock("react-i18next", () => {
  const resolveKey = (key: string): string | undefined => {
    let acc: unknown = en;
    for (const part of key.split(".")) {
      if (typeof acc === "object" && acc !== null) {
        acc = (acc as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }
    return typeof acc === "string" ? acc : undefined;
  };
  return {
    useTranslation: () => ({
      t: (key: string, fallback?: string) => resolveKey(key) ?? fallback ?? key,
    }),
  };
});

/** The rail's shipped width (`w-[125px]`); the drag math is width-relative. */
const BAR_WIDTH_PX = 125;

function mockBarRect(width: number): HTMLElement {
  const bar = screen.getByTestId("pip-volume-bar");
  const rect = {
    left: 0,
    right: width,
    top: 0,
    bottom: 6,
    width,
    height: 6,
    x: 0,
    y: 0,
    toJSON: () => undefined,
  } as DOMRect;
  vi.spyOn(bar, "getBoundingClientRect").mockReturnValue(rect);
  return bar;
}

interface RenderOverrides {
  volume?: number;
  isMuted?: boolean;
  hideRail?: boolean;
}

function renderSlider(overrides: RenderOverrides = {}) {
  const onVolumeChange = vi.fn<(value: number) => void>();
  const onToggleMute = vi.fn<() => void>();
  const view = render(
    <PipVolumeSlider
      volume={overrides.volume ?? 0.5}
      isMuted={overrides.isMuted ?? false}
      onVolumeChange={onVolumeChange}
      onToggleMute={onToggleMute}
      {...(overrides.hideRail === undefined
        ? {}
        : { hideRail: overrides.hideRail })}
    />,
  );
  return { ...view, onVolumeChange, onToggleMute };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PipVolumeSlider fill", () => {
  it("sizes the fill from volume * 100", () => {
    renderSlider({ volume: 0.35 });
    expect(screen.getByTestId("pip-volume-fill").style.width).toBe("35%");
  });

  it("collapses the fill to 0% while muted, whatever the volume is", () => {
    renderSlider({ volume: 0.8, isMuted: true });
    expect(screen.getByTestId("pip-volume-fill").style.width).toBe("0%");
  });
});

describe("PipVolumeSlider icon ladder", () => {
  it("matches the shared VolumeSlider's four levels", () => {
    const { container, unmount } = renderSlider({ volume: 0 });
    expect(container.querySelector(".lucide-volume-x")).not.toBeNull();
    unmount();

    const low = renderSlider({ volume: 0.2 });
    expect(low.container.querySelector(".lucide-volume")).not.toBeNull();
    low.unmount();

    const medium = renderSlider({ volume: 0.5 });
    expect(medium.container.querySelector(".lucide-volume-1")).not.toBeNull();
    medium.unmount();

    const high = renderSlider({ volume: 0.8 });
    expect(high.container.querySelector(".lucide-volume-2")).not.toBeNull();
  });

  it("shows the muted icon even at a non-zero volume", () => {
    const { container } = renderSlider({ volume: 0.8, isMuted: true });
    expect(container.querySelector(".lucide-volume-x")).not.toBeNull();
  });
});

describe("PipVolumeSlider mute affordance", () => {
  it("is a focusable button that toggles mute once per click", () => {
    const { container, onToggleMute } = renderSlider({ volume: 0.5 });
    const button = screen.getByRole("button", { name: "Mute" });

    // The shared VolumeSlider draws a bare <svg onClick>, which no keyboard
    // user can reach. The PiP copy must not inherit that bug.
    expect(button.tagName).toBe("BUTTON");
    expect(container.querySelector("svg[onClick]")).toBeNull();

    fireEvent.click(button);
    expect(onToggleMute).toHaveBeenCalledTimes(1);
  });

  it("labels the button 'Unmute' while muted", () => {
    renderSlider({ volume: 0.5, isMuted: true });
    expect(screen.getByRole("button", { name: "Unmute" })).toBeTruthy();
  });
});

describe("PipVolumeSlider drag", () => {
  it("reports the pressed position as a 0..1 volume", () => {
    const { onVolumeChange } = renderSlider({ volume: 0.5 });
    const bar = mockBarRect(BAR_WIDTH_PX);

    act(() => {
      fireEvent.pointerDown(bar, { clientX: 62.5, pointerId: 1 });
    });

    expect(onVolumeChange).toHaveBeenCalledTimes(1);
    expect(onVolumeChange).toHaveBeenLastCalledWith(0.5);
  });

  it("clamps a press outside the rail into 0..1", () => {
    const { onVolumeChange } = renderSlider({ volume: 0.5 });
    const bar = mockBarRect(BAR_WIDTH_PX);

    act(() => {
      fireEvent.pointerDown(bar, { clientX: -40, pointerId: 1 });
    });
    expect(onVolumeChange).toHaveBeenLastCalledWith(0);

    act(() => {
      fireEvent.pointerDown(bar, { clientX: 500, pointerId: 1 });
    });
    expect(onVolumeChange).toHaveBeenLastCalledWith(1);
  });

  it("ignores pointermove events from a pointer that did not start the drag", () => {
    const { onVolumeChange } = renderSlider({ volume: 0.5 });
    const bar = mockBarRect(BAR_WIDTH_PX);

    act(() => {
      fireEvent.pointerDown(bar, { clientX: 62.5, pointerId: 1 });
    });
    expect(onVolumeChange).toHaveBeenCalledTimes(1);

    // A second finger must not be able to drive (or end) this drag.
    act(() => {
      fireEvent.pointerMove(window, { clientX: 125, pointerId: 2 });
    });
    expect(onVolumeChange).toHaveBeenCalledTimes(1);
  });

  it("follows the owner pointer and stops after pointerup", () => {
    const { onVolumeChange } = renderSlider({ volume: 0.5 });
    const bar = mockBarRect(BAR_WIDTH_PX);

    act(() => {
      fireEvent.pointerDown(bar, { clientX: 62.5, pointerId: 1 });
    });
    act(() => {
      fireEvent.pointerMove(window, { clientX: 125, pointerId: 1 });
    });
    expect(onVolumeChange).toHaveBeenLastCalledWith(1);

    act(() => {
      fireEvent.pointerUp(window, { clientX: 125, pointerId: 1 });
    });
    act(() => {
      fireEvent.pointerMove(window, { clientX: 0, pointerId: 1 });
    });

    expect(onVolumeChange).toHaveBeenCalledTimes(2);
    expect(onVolumeChange).toHaveBeenLastCalledWith(1);
  });

  it("stops on pointercancel too", () => {
    const { onVolumeChange } = renderSlider({ volume: 0.5 });
    const bar = mockBarRect(BAR_WIDTH_PX);

    act(() => {
      fireEvent.pointerDown(bar, { clientX: 62.5, pointerId: 1 });
    });
    act(() => {
      fireEvent.pointerCancel(window, { clientX: 62.5, pointerId: 1 });
    });
    act(() => {
      fireEvent.pointerMove(window, { clientX: 100, pointerId: 1 });
    });

    expect(onVolumeChange).toHaveBeenCalledTimes(1);
  });

  it("removes the window listeners when unmounted mid-drag", () => {
    const { unmount, onVolumeChange } = renderSlider({ volume: 0.5 });
    const bar = mockBarRect(BAR_WIDTH_PX);

    act(() => {
      fireEvent.pointerDown(bar, { clientX: 62.5, pointerId: 1 });
    });
    expect(onVolumeChange).toHaveBeenCalledTimes(1);

    // Closing the PiP window with the finger still down must not leave a
    // window-level listener writing into a dead component.
    unmount();
    act(() => {
      fireEvent.pointerMove(window, { clientX: 125, pointerId: 1 });
    });
    act(() => {
      fireEvent.pointerUp(window, { clientX: 125, pointerId: 1 });
    });

    expect(onVolumeChange).toHaveBeenCalledTimes(1);
  });

  it("reports nothing when the rail has no layout width", () => {
    const { onVolumeChange } = renderSlider({ volume: 0.5 });
    const bar = mockBarRect(0);

    act(() => {
      fireEvent.pointerDown(bar, { clientX: 10, pointerId: 1 });
    });

    // bounds.width <= 0 would divide into Infinity/NaN.
    expect(onVolumeChange).not.toHaveBeenCalled();
  });
});

describe("PipVolumeSlider compact mode", () => {
  it("drops the rail but keeps the mute button", () => {
    renderSlider({ volume: 0.5, hideRail: true });

    expect(screen.queryByTestId("pip-volume-bar")).toBeNull();
    expect(screen.getByRole("button", { name: "Mute" })).toBeTruthy();
  });
});
