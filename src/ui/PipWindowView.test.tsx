// @vitest-environment jsdom
//
// PiP chrome parity (Slice 3/3): the transport row and the top-bar icons are
// the last two places where the PiP window still shipped its own look. These
// tests pin the behaviours the full-screen surfaces already guarantee — the
// spinner/retry ladder, the download gate, ONE merged time read-out, and the
// 1s auto-hide — because "parity" that is not asserted drifts back at the next
// edit.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { PipWindowView } from "./PipWindowView";
import { PIP_EVENTS, type PipStatePayload } from "../lib/pipWindow";
import en from "../locales/en/translation.json";

interface CapturedListen {
  (event: { payload: unknown }): void;
}

/** Shape of the plain-object stand-in for `PhysicalSize` / `Monitor.size`. */
interface FakeSize {
  width: number;
  height: number;
}

interface FakeMonitor {
  name: string;
  position: { x: number; y: number };
  size: FakeSize;
  scaleFactor: number;
}

interface FakeWindow {
  emitTo: (target: string, event: string, payload?: unknown) => Promise<void>;
  onCloseRequested: (
    handler: (event: { preventDefault: () => void }) => void,
  ) => Promise<() => void>;
  destroy: () => Promise<void>;
  /** PHYSICAL px, like the real binding. */
  innerSize: () => Promise<FakeSize>;
  scaleFactor: () => Promise<number>;
  setSize: (size: unknown) => Promise<void>;
  setMinSize: (size: unknown) => Promise<void>;
}

const DEFAULT_MONITOR: FakeMonitor = {
  name: "test-monitor",
  position: { x: 0, y: 0 },
  size: { width: 2560, height: 1440 },
  scaleFactor: 2,
};

const mocks = vi.hoisted(() => ({
  listenHandlers: new Map<string, CapturedListen>(),
  emitTo: vi.fn((...args: [string, string, unknown?]) => {
    void args;
    return Promise.resolve();
  }),
  emit: vi.fn(() => Promise.resolve()),
  onCloseRequested: vi.fn(() => Promise.resolve(() => undefined)),
  destroy: vi.fn(() => Promise.resolve()),
  invoke: vi.fn((...args: [string, unknown?]) => {
    void args;
    return Promise.resolve<unknown>(undefined);
  }),
  innerSize: vi.fn(() => Promise.resolve({ width: 480, height: 300 })),
  scaleFactor: vi.fn(() => Promise.resolve(1)),
  setSize: vi.fn((...args: [unknown]) => {
    void args;
    return Promise.resolve();
  }),
  setMinSize: vi.fn((...args: [unknown]) => {
    void args;
    return Promise.resolve();
  }),
  currentMonitor: vi.fn(() =>
    Promise.resolve({
      name: "test-monitor",
      position: { x: 0, y: 0 },
      size: { width: 2560, height: 1440 },
      scaleFactor: 2,
    }),
  ),
  getVideoAspect: vi.fn(() => Promise.resolve(16 / 9)),
  captureError: vi.fn((...args: [unknown]) => {
    void args;
    return Promise.resolve();
  }),
}));

// The view asks Rust to install the native browser-accelerator policy on this
// webview when it mounts. There is no bridge in jsdom, so it is mocked here and
// asserted below — that call IS the layer that stops WebView2's print dialog.
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string, handler: CapturedListen) => {
    mocks.listenHandlers.set(event, handler);
    return Promise.resolve(() => undefined);
  }),
  emitTo: mocks.emitTo,
  emit: mocks.emit,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: (): FakeWindow => ({
    emitTo: mocks.emitTo,
    onCloseRequested: mocks.onCloseRequested,
    destroy: mocks.destroy,
    innerSize: mocks.innerSize,
    scaleFactor: mocks.scaleFactor,
    setSize: mocks.setSize,
    setMinSize: mocks.setMinSize,
  }),
  currentMonitor: mocks.currentMonitor,
}));

// Real-shaped far enough for assertions: the view hands a LogicalSize to
// `setSize`/`setMinSize`, and the tests read the numbers back off it.
vi.mock("@tauri-apps/api/dpi", () => ({
  LogicalSize: class LogicalSize {
    public width: number;
    public height: number;
    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
    }
  },
}));

// The real getter talks to mpv over IPC. Each test sets the ratio it wants; the
// module is mocked rather than the bridge because the fallback chain inside
// `getVideoAspect` is covered by the mpvControl tests, not here.
vi.mock("../lib/mpvControl/videoControls", () => ({
  getVideoAspect: mocks.getVideoAspect,
}));

// `captureError` writes to IndexedDB, which jsdom does not implement; mocking it
// also lets the aspect tests assert that a degraded path still reports itself.
vi.mock("../utils/errorLog", () => ({ captureError: mocks.captureError }));

// The real module only needs `WebviewWindow` at import time; the PiP view never
// constructs a window itself.
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: { getByLabel: () => null },
}));

// The video surface owns the native host rect sync and its own spinner. It is
// NOT under test here (and would flood the assertions with IPC noise), so it
// is replaced by an inert stand-in that keeps the exported event name.
vi.mock("./NowPlaying/components/VideoSurface", () => ({
  VideoSurface: () => null,
  VIDEO_HOST_OWNER_CHANGED_EVENT: "drplay:video-host-owner-changed",
}));

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

const BASE_STATE: PipStatePayload = {
  title: "Video",
  isPlaying: false,
  currentTime: 0,
  duration: 120,
  volume: 0.5,
  isMuted: false,
  hasTrack: true,
  isVideo: true,
  isBuffering: false,
  hasError: false,
  hasEnded: false,
  buffered: [],
  isDownloading: false,
  trackId: "video-1",
};

/**
 * Drain the component's listener-registration chain. It is one async IIFE that
 * awaits five `listen()` calls in sequence (plus `onCloseRequested`), so a
 * bounded number of microtask turns settles it. `waitFor` is deliberately NOT
 * used: the chrome tests run on fake timers, where it would never advance.
 *
 * NOTE: `PIP_EVENTS.action` is a MAIN-window listener — the PiP view only
 * SENDS actions — so it is deliberately not part of this gate.
 */
const PIP_LISTENED_EVENTS = [
  PIP_EVENTS.state,
  PIP_EVENTS.owner,
  PIP_EVENTS.release,
  PIP_EVENTS.requestReady,
  PIP_EVENTS.refreshSurface,
] as const;

async function flushRegistration(maxTurns = 30): Promise<void> {
  for (let turn = 0; turn < maxTurns; turn += 1) {
    const registered = PIP_LISTENED_EVENTS.every((event) =>
      mocks.listenHandlers.has(event),
    );
    // One extra turn so the final registration in the chain is committed.
    await act(async () => {
      await Promise.resolve();
    });
    if (registered) return;
  }
  throw new Error("pip listeners never registered");
}

async function mountView(): Promise<ReturnType<typeof render>> {
  const view = render(<PipWindowView />);
  await flushRegistration();
  return view;
}

/** Drive the real `pip-state` listener, exactly as the IPC bridge would. */
type StateOverride = Omit<Partial<PipStatePayload>, "trackId"> & {
  /** Explicit `undefined` is the "field absent" case older publishes have. */
  trackId?: string | null | undefined;
};

async function publish(overrides: StateOverride): Promise<void> {
  const handler = mocks.listenHandlers.get(PIP_EVENTS.state);
  if (handler === undefined) throw new Error("expected a pip-state listener");
  await act(async () => {
    handler({ payload: { ...BASE_STATE, ...overrides } });
    await Promise.resolve();
  });
}

/** The centre transport button (the only w-11 box in the row). */
function transportButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>("button.w-11");
  if (button === null) throw new Error("expected the transport button");
  return button;
}

function hasIcon(root: HTMLElement, icon: string): boolean {
  return root.querySelector(`.lucide-${icon}`) !== null;
}

/** Let the aspect effect's await chain settle in a bounded number of turns. */
async function settle(turns = 24): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** Every `pip_set_aspect_cmd` payload sent to Rust, in order. */
function aspectInvocations(): unknown[] {
  return mocks.invoke.mock.calls
    .filter(([command]) => command === "pip_set_aspect_cmd")
    .map(([, args]) => args);
}

beforeEach(() => {
  mocks.listenHandlers.clear();
  mocks.emitTo.mockClear();
  mocks.emit.mockClear();
  mocks.onCloseRequested.mockClear();
  mocks.destroy.mockClear();
  mocks.invoke.mockClear();
  mocks.innerSize.mockClear();
  mocks.scaleFactor.mockClear();
  mocks.setSize.mockClear();
  mocks.setMinSize.mockClear();
  mocks.currentMonitor.mockClear();
  mocks.getVideoAspect.mockClear();
  mocks.captureError.mockClear();
  mocks.innerSize.mockResolvedValue({ width: 480, height: 300 });
  mocks.scaleFactor.mockResolvedValue(1);
  mocks.setSize.mockResolvedValue(undefined);
  mocks.setMinSize.mockResolvedValue(undefined);
  mocks.currentMonitor.mockResolvedValue(DEFAULT_MONITOR);
  mocks.getVideoAspect.mockResolvedValue(16 / 9);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PipWindowView transport button", () => {
  it("becomes the retry affordance while the track has an error", async () => {
    await mountView();
    await publish({ hasError: true });

    const button = transportButton();
    expect(hasIcon(button, "refresh-cw")).toBe(true);
    expect(button.getAttribute("aria-label")).toBe("Retry");

    fireEvent.click(button);
    expect(mocks.emitTo).toHaveBeenCalledWith("main", PIP_EVENTS.action, {
      action: "retry",
      payload: undefined,
    });
  });

  it("spins while buffering without disabling the button", async () => {
    await mountView();
    await publish({ isBuffering: true, isPlaying: false });

    const button = transportButton();
    expect(hasIcon(button, "loader-circle")).toBe(true);
    expect(button.disabled).toBe(false);
    expect(hasIcon(button, "play")).toBe(false);
  });

  it("spins and disables itself during the download window", async () => {
    await mountView();
    await publish({ isDownloading: true, isPlaying: false });

    const button = transportButton();
    expect(hasIcon(button, "loader-circle")).toBe(true);
    expect(button.disabled).toBe(true);
  });

  it("prefers the retry icon over the spinner when the track errored", async () => {
    await mountView();
    await publish({ hasError: true, isBuffering: true });

    expect(hasIcon(transportButton(), "refresh-cw")).toBe(true);
    expect(hasIcon(transportButton(), "loader-circle")).toBe(false);
  });

  it("shows Pause while playing and toggles playback on click", async () => {
    await mountView();
    await publish({ isPlaying: true });

    const button = transportButton();
    expect(hasIcon(button, "pause")).toBe(true);
    expect(button.getAttribute("aria-label")).toBe("Pause");

    fireEvent.click(button);
    expect(mocks.emitTo).toHaveBeenCalledWith("main", PIP_EVENTS.action, {
      action: "togglePlay",
      payload: undefined,
    });
  });

  it("shows Play while paused", async () => {
    await mountView();
    await publish({ isPlaying: false });

    expect(hasIcon(transportButton(), "play")).toBe(true);
  });
});

/**
 * The transport trio used to sit in the bottom gradient bar, i.e. in a corner
 * of a window whose whole job is playing one video. Play/pause must be the
 * thing the eye lands on, so the trio moved to a centred overlay. These tests
 * pin the MOVE (not just the presence) — the buttons still exist, still carry
 * the same labels, but they must no longer live in the bottom bar row.
 */
describe("PipWindowView centred transport trio", () => {
  function centreGroup(): HTMLElement {
    return screen.getByTestId("pip-transport-center");
  }

  function bottomBar(): HTMLElement {
    return screen.getByTestId("pip-bottom-bar");
  }

  it("renders prev/play/next inside the centred overlay, out of the bottom bar", async () => {
    await mountView();

    const centre = centreGroup();
    const play = transportButton();
    const prev = screen.getByRole("button", { name: en.player.prev });
    const next = screen.getByRole("button", { name: en.player.next });

    expect(centre.contains(play)).toBe(true);
    expect(centre.contains(prev)).toBe(true);
    expect(centre.contains(next)).toBe(true);
    // The clock is chrome of the bottom row and must NOT travel with them.
    expect(centre.contains(screen.getByTestId("pip-time-display"))).toBe(false);
    // Sibling of the bottom bar: both are direct children of the chrome node.
    expect(centre.parentElement).toBe(bottomBar().parentElement);
    expect(bottomBar().contains(play)).toBe(false);
    expect(bottomBar().contains(prev)).toBe(false);
    expect(bottomBar().contains(next)).toBe(false);
  });

  it("hides and reappears with the rest of the chrome", async () => {
    vi.useFakeTimers();
    await mountView();

    const controls = screen.getByTestId("pip-controls");
    // Living inside `pip-controls` is what makes it inherit opacity-0 + inert.
    expect(controls.contains(centreGroup())).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1_100);
    });

    expect(controls.className).toContain("opacity-0");
    expect(controls.contains(centreGroup())).toBe(true);
  });

  it("keeps the trio usable in the compact layout", async () => {
    // Same trigger as the compact time-display test: the height is read once
    // by the state initializer, so the spy has to be installed before mount.
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(300);
    await mountView();

    expect(centreGroup().contains(transportButton())).toBe(true);
    expect(screen.getByRole("button", { name: en.player.prev })).toBeTruthy();
    expect(screen.getByRole("button", { name: en.player.next })).toBeTruthy();
  });
});

describe("PipWindowView merged time display", () => {
  it("renders ONE 'current / total' read-out", async () => {
    await mountView();
    await publish({ currentTime: 12, duration: 120 });

    const display = screen.getByTestId("pip-time-display");
    expect(display.textContent).toBe("0:12 / 2:00");
    // The seek bar no longer draws its own clocks, so this is the only one.
    expect(screen.queryAllByTestId("pip-time-display")).toHaveLength(1);
  });

  it("falls back to --:-- before a duration is known", async () => {
    await mountView();
    await publish({ currentTime: 0, duration: 0 });

    expect(screen.getByTestId("pip-time-display").textContent).toBe(
      "0:00 / --:--",
    );
  });

  it("keeps the read-out in compact layout", async () => {
    // The compact row drops the seek bar, so without the merged display the
    // window would have no time read-out at all.
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(300);
    await mountView();
    await publish({ currentTime: 12, duration: 120 });

    expect(screen.getByTestId("pip-time-display").textContent).toBe(
      "0:12 / 2:00",
    );
  });
});

describe("PipWindowView chrome auto-hide", () => {
  it("hides the controls after 1s of inactivity", async () => {
    // Installed BEFORE mount: the countdown is armed by a mount effect, so a
    // real timer armed first would never be reachable by advanceTimersByTime.
    vi.useFakeTimers();
    await mountView();

    const controls = screen.getByTestId("pip-controls");
    expect(controls.className).not.toContain("opacity-0");

    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(controls.className).not.toContain("opacity-0");

    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(controls.className).toContain("opacity-0");
  });
});

describe("PipWindowView volume control", () => {
  it("replaces the native range input with the shared rail look", async () => {
    await mountView();

    expect(document.querySelector("input[type='range']")).toBeNull();
    expect(screen.getByTestId("pip-volume-bar")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Mute" })).toBeTruthy();
  });
});

describe("PipWindowView seek bar gating", () => {
  it("keeps the rail non-seekable once the video ended", async () => {
    await mountView();
    await publish({ hasEnded: true });

    const classes = screen.getByRole("slider").className.split(" ");
    expect(classes).toContain("cursor-default");
    expect(classes).not.toContain("cursor-pointer");
  });

  it("keeps the rail non-seekable while the track errored", async () => {
    await mountView();
    await publish({ hasError: true });

    const classes = screen.getByRole("slider").className.split(" ");
    expect(classes).toContain("cursor-default");
    expect(classes).not.toContain("cursor-pointer");
  });
});

describe("PipWindowView top-bar actions: Return vs Close", () => {
  function topBarButton(name: string): HTMLButtonElement {
    return screen.getByRole("button", { name });
  }

  it("Return hands the video back AND brings the app forward", async () => {
    await mountView();

    fireEvent.click(topBarButton(en.player.pip.return_to_player));

    expect(mocks.emitTo).toHaveBeenCalledWith("main", PIP_EVENTS.action, {
      action: "return",
      payload: undefined,
    });
  });

  it("Close dismisses the floating window instead of returning", async () => {
    await mountView();

    fireEvent.click(topBarButton(en.player.pip.close));

    // "closePip" is the background-close action: main must NOT show/focus
    // itself nor reopen Now Playing. Sending "return" here would do all three.
    expect(mocks.emitTo).toHaveBeenCalledWith("main", PIP_EVENTS.action, {
      action: "closePip",
      payload: undefined,
    });
    expect(mocks.emitTo).not.toHaveBeenCalledWith("main", PIP_EVENTS.action, {
      action: "return",
      payload: undefined,
    });
  });
});

/**
 * Ctrl+P inside the PiP window. Two layers make this work and both must stay:
 * the native WebView2 accelerator policy (layer one, Rust) stops the browser's
 * print dialog, and this listener (layer two) turns the chord into RETURN.
 *
 * Return, not Close: Ctrl+P is the toggle whose other half opens PiP from the
 * main window (`PLAYER_PIP_TOGGLE` -> `togglePip` -> `returnFromPip`), so the
 * reverse press must bring the app forward symmetrically. The X stays the
 * separate "background close" affordance.
 */
describe("PipWindowView Ctrl+P returns to the app", () => {
  function pressCtrlP(init: KeyboardEventInit = {}): KeyboardEvent {
    return pressKey({ key: "p", ctrlKey: true, ...init });
  }

  function pressKey(init: KeyboardEventInit): KeyboardEvent {
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ...init,
    });
    window.dispatchEvent(event);
    return event;
  }

  /** Every action name the view sent to main, in order. */
  function actionCalls(): string[] {
    return mocks.emitTo.mock.calls
      .filter(([, event]) => event === PIP_EVENTS.action)
      .map(([, , payload]) => (payload as { action?: string }).action ?? "");
  }

  it("installs the native accelerator policy on mount", async () => {
    await mountView();

    expect(mocks.invoke).toHaveBeenCalledWith("pip_install_keys_cmd");
  });

  it("sends return and consumes the chord", async () => {
    await mountView();

    const event = pressCtrlP();

    expect(event.defaultPrevented).toBe(true);
    expect(mocks.emitTo).toHaveBeenCalledWith("main", PIP_EVENTS.action, {
      action: "return",
      payload: undefined,
    });
    // Toggle symmetry: Ctrl+P is NOT the X, so it must never take the
    // background-close path.
    expect(mocks.emitTo).not.toHaveBeenCalledWith("main", PIP_EVENTS.action, {
      action: "closePip",
      payload: undefined,
    });
  });

  it("ignores the same key without Ctrl", async () => {
    await mountView();

    const event = pressKey({ key: "p" });

    // Superseded contract: a bare `p` used to be "no listener claimed it".
    // Inside PiP NOTHING may reach the app, so the chord is now swallowed —
    // still without emitting anything.
    expect(event.defaultPrevented).toBe(true);
    expect(mocks.emitTo).not.toHaveBeenCalledWith("main", PIP_EVENTS.action, {
      action: "return",
      payload: undefined,
    });
    expect(actionCalls()).toEqual([]);
  });

  it("ignores Ctrl+Shift+P and every other modifier variant", async () => {
    await mountView();

    for (const init of [
      { shiftKey: true },
      { altKey: true },
      { metaKey: true },
    ] as KeyboardEventInit[]) {
      const event = pressCtrlP(init);
      // Superseded contract: these variants are not Ctrl+P, so they must not
      // send anything — but they are still blocked like every other key.
      expect(event.defaultPrevented).toBe(true);
    }

    expect(mocks.emitTo).not.toHaveBeenCalledWith("main", PIP_EVENTS.action, {
      action: "return",
      payload: undefined,
    });
    expect(actionCalls()).toEqual([]);
  });
});

/**
 * The PiP window is a bare video surface: it must not forward ANY shortcut to
 * the app. The app's transport keys (Space, arrows, M, P, N, F, ...) are bound
 * on `window` in the MAIN document; if they ever also fired here the floating
 * window would drive playback twice. This block is the blanket half of the
 * policy — Ctrl+P above is the single exception.
 */
describe("PipWindowView blocks every other shortcut", () => {
  interface KeyCase {
    label: string;
    init: KeyboardEventInit;
  }

  const BLOCKED_KEYS: KeyCase[] = [
    { label: "Space", init: { key: " " } },
    { label: "ArrowRight", init: { key: "ArrowRight" } },
    { label: "Shift+ArrowRight", init: { key: "ArrowRight", shiftKey: true } },
    { label: "m", init: { key: "m" } },
    { label: "f", init: { key: "f" } },
    { label: "n", init: { key: "n" } },
    { label: "bare p", init: { key: "p" } },
    { label: "F12", init: { key: "F12" } },
  ];

  for (const { label, init } of BLOCKED_KEYS) {
    it(`swallows ${label} without emitting an action`, async () => {
      await mountView();

      const event = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        ...init,
      });
      window.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      // The PiP view only ever SENDS actions; a blocked key must send none.
      const actions = mocks.emitTo.mock.calls
        .filter(([, name]) => name === PIP_EVENTS.action)
        .map(([, , payload]) => (payload as { action?: string }).action);
      expect(actions).toEqual([]);
    });
  }

  it("blocks the key before a bubble-phase listener can act on it", async () => {
    await mountView();

    const sawBubble = vi.fn();
    // Bubble phase on `window` is the LAST stop of the propagation path, so it
    // stands in for any app shortcut handler that might be mounted later.
    window.addEventListener("keydown", sawBubble);
    try {
      const event = new KeyboardEvent("keydown", {
        key: " ",
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(event);

      expect(sawBubble).toHaveBeenCalledTimes(1);
      expect(
        (sawBubble.mock.calls[0]?.[0] as KeyboardEvent).defaultPrevented,
      ).toBe(true);
    } finally {
      window.removeEventListener("keydown", sawBubble);
    }
  });

  it("keeps the chrome revealed by a blocked key", async () => {
    vi.useFakeTimers();
    await mountView();

    act(() => {
      vi.advanceTimersByTime(1_500);
    });
    const controls = screen.getByTestId("pip-controls");
    expect(controls.className).toContain("opacity-0");

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: " ",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(controls.className).not.toContain("opacity-0");
  });
});

/**
 * The PiP document renders this view instead of `App`, so `useAppGlobalEvents`
 * (the main window's blanket block) never mounts there and WebView2 would show
 * its own menu — reload / save as / inspect / print — inside the floating
 * player. This block has to be installed and torn down by the view itself.
 */
describe("PipWindowView blocks the WebView2 context menu", () => {
  function dispatchContextMenu(): MouseEvent {
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);
    return event;
  }

  it("prevents the default menu while mounted", async () => {
    await mountView();

    expect(dispatchContextMenu().defaultPrevented).toBe(true);
  });

  it("releases document once the view unmounts", async () => {
    const view = await mountView();
    view.unmount();

    expect(dispatchContextMenu().defaultPrevented).toBe(false);
  });
});

/**
 * The PiP window is locked to the video's aspect ratio in Rust (a WM_SIZING
 * subclass), but that only constrains DRAGS. mpv letterboxes inside whatever
 * client area it is given, so the window itself also has to be resized to the
 * video's ratio — otherwise the picture keeps black bars and the lock looks
 * broken. These tests pin the apply sequence: current width -> ratio height ->
 * monitor clamp -> setSize -> ratio-aware setMinSize -> native lock LAST.
 */
describe("PipWindowView aspect lock", () => {
  const SIXTEEN_BY_NINE = 16 / 9;
  const PORTRAIT = 9 / 16;

  /** Mount, then publish a video state (the apply only runs once a video shows). */
  async function mountWithVideo(
    overrides: Partial<PipStatePayload> = {},
  ): Promise<void> {
    await mountView();
    await publish({ isVideo: true, hasTrack: true, ...overrides });
    await settle();
  }

  function setSizeCalls(): { width: number; height: number }[] {
    return mocks.setSize.mock.calls.map(([size]) => {
      const arg = size as { width: number; height: number };
      return { width: arg.width, height: arg.height };
    });
  }

  function setMinSizeCalls(): { width: number; height: number }[] {
    return mocks.setMinSize.mock.calls.map(([size]) => {
      const arg = size as { width: number; height: number };
      return { width: arg.width, height: arg.height };
    });
  }

  it("resizes a 16:9 video to the width it already had, in LOGICAL px", async () => {
    // 480x300 PHYSICAL at scaleFactor 1 => 480 logical on BOTH axes. The trap
    // this pins: treating innerSize() as logical silently breaks on HiDPI.
    await mountWithVideo();

    expect(setSizeCalls()).toEqual([{ width: 480, height: 270 }]);
    const firstSize = mocks.setSize.mock.calls[0]?.[0];
    expect(firstSize).toBeInstanceOf(LogicalSize);
    // The floor has to follow the ratio too, or WM_GETMINMAXINFO (applied AFTER
    // WM_SIZING) clamps 320x180 back to 320x200 and the lock leaks.
    expect(setMinSizeCalls()).toEqual([{ width: 320, height: 180 }]);
    expect(aspectInvocations()).toEqual([{ aspect: SIXTEEN_BY_NINE }]);
  });

  it("clamps a portrait video to the monitor and keeps the ratio", async () => {
    mocks.getVideoAspect.mockResolvedValue(PORTRAIT);
    // 1280x720 logical monitor => 90% caps of 1152x648.
    mocks.currentMonitor.mockResolvedValue({
      name: "small",
      position: { x: 0, y: 0 },
      size: { width: 1280, height: 720 },
      scaleFactor: 1,
    });

    await mountWithVideo();

    const [sized] = setSizeCalls();
    if (sized === undefined) throw new Error("expected a setSize call");
    // Unclamped this would be 480 / (9/16) = 853 logical px tall, taller than
    // the 648 cap — a 9:16 video that runs off the screen.
    expect(sized.height).toBe(648);
    expect(sized.height).toBeLessThanOrEqual(720 * 0.9);
    expect(Math.abs(sized.width - sized.height * PORTRAIT)).toBeLessThanOrEqual(
      1,
    );
    expect(setMinSizeCalls()).toEqual([{ width: 180, height: 320 }]);
    expect(aspectInvocations()).toEqual([{ aspect: PORTRAIT }]);
  });

  it("does nothing when the aspect is unknown", async () => {
    mocks.getVideoAspect.mockResolvedValue(0);

    await mountWithVideo();

    expect(mocks.setSize).not.toHaveBeenCalled();
    expect(mocks.setMinSize).not.toHaveBeenCalled();
    expect(aspectInvocations()).toEqual([]);
    // Alerting on a silent no-op is the difference between "the lock is off"
    // and "the lock is off and nobody knows why".
    expect(mocks.captureError).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warn", kind: "aspect-unknown" }),
    );
    // A missing ratio must cost only the resize, never the chrome.
    expect(screen.getByTestId("pip-controls")).toBeTruthy();
  });

  it("does nothing and swallows the error when the aspect query rejects", async () => {
    mocks.getVideoAspect.mockRejectedValue(new Error("mpv bridge down"));

    await mountWithVideo();

    expect(mocks.setSize).not.toHaveBeenCalled();
    expect(mocks.setMinSize).not.toHaveBeenCalled();
    expect(aspectInvocations()).toEqual([]);
    expect(mocks.captureError).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warn", kind: "aspect-query-failed" }),
    );
    expect(screen.getByTestId("pip-controls")).toBeTruthy();
  });

  it("still installs the floor and the lock when setSize fails", async () => {
    // Decision: the three steps are independent best-effort operations. Bailing
    // out would leave the OLD video's min size and OLD video's WM_SIZING ratio
    // in place — a stale lock is worse than a window that keeps its current
    // rect until the next media change retries the whole sequence.
    mocks.setSize.mockRejectedValue(new Error("setSize failed"));

    await mountWithVideo();

    expect(setMinSizeCalls()).toEqual([{ width: 320, height: 180 }]);
    expect(aspectInvocations()).toEqual([{ aspect: SIXTEEN_BY_NINE }]);
    // No unhandled rejection: vitest would fail this file outright if one
    // escaped, and the render must survive the failure.
    expect(screen.getByTestId("pip-controls")).toBeTruthy();
  });

  it("re-applies when the loaded media changes", async () => {
    await mountView();
    // Title + duration move on a track switch, so they are the closest thing
    // to an identity when the payload carries no id.
    await publish({ title: "First video", duration: 120 });
    await settle();
    expect(mocks.setSize).toHaveBeenCalledTimes(1);

    await publish({ title: "Second video", duration: 300 });
    await settle();

    expect(mocks.setSize).toHaveBeenCalledTimes(2);
    expect(aspectInvocations()).toHaveLength(2);
  });

  it("F: re-applies for two different items with IDENTICAL title and duration", async () => {
    await mountView();
    // Same metadata, different media — e.g. a movie and its director's cut.
    // Title+duration alone made this key collide and the new video kept the
    // old ratio locked; the stable track id is what separates them.
    await publish({ trackId: "a", title: "Same", duration: 120 });
    await settle();
    expect(aspectInvocations()).toHaveLength(1);
    expect(mocks.setSize).toHaveBeenCalledTimes(1);

    await publish({ trackId: "b", title: "Same", duration: 120 });
    await settle();

    expect(aspectInvocations()).toHaveLength(2);
    expect(mocks.setSize).toHaveBeenCalledTimes(2);
  });

  it("G: ordinary playback updates of the SAME item do not re-apply", async () => {
    await mountView();
    // The identity fields are carried by EVERY publish below: a real publisher
    // rebuilds the payload from the same track, so title/duration hold steady
    // for one item. Dropping back to BASE_STATE here would change the title
    // and prove nothing about time/buffer traffic.
    const SAME_ITEM = { trackId: "a", title: "Same", duration: 120 };
    await publish(SAME_ITEM);
    await settle();
    expect(aspectInvocations()).toHaveLength(1);

    // Every field the poller churns (~4x/s) while one video plays. None of
    // them is media identity, so the window must not be resized again — that
    // would fight a user's manual resize several times a second.
    for (const patch of [
      { currentTime: 10 },
      { isBuffering: true },
      { volume: 0.3 },
      { isMuted: true },
      { isPlaying: true },
      { buffered: [{ start: 0, end: 10 }] },
      { isDownloading: true },
    ] as StateOverride[]) {
      await publish({ ...SAME_ITEM, ...patch });
    }
    await settle();

    expect(aspectInvocations()).toHaveLength(1);
    // The updates really did arrive (the listener is not silently dead).
    expect(screen.getByTestId("pip-controls")).toBeTruthy();
  });

  it("H: missing identity still renders and keeps the media gates", async () => {
    await mountView();
    // Older/partial publishes carry no id at all. The view must render, and
    // the gates must still refuse a video-only apply for non-video media.
    await publish({ trackId: null });
    await settle();
    expect(screen.getByTestId("pip-controls")).toBeTruthy();

    await publish({ trackId: undefined });
    await settle();
    expect(screen.getByTestId("pip-controls")).toBeTruthy();

    // Fresh mount: an audio track (and then no track) must never trigger the
    // native aspect call, whatever the identity says.
    cleanup();
    mocks.invoke.mockClear();
    mocks.setSize.mockClear();
    mocks.listenHandlers.clear();
    await mountView();
    await publish({ trackId: null, hasTrack: false, isVideo: false });
    await settle();
    await publish({ trackId: undefined, hasTrack: true, isVideo: false });
    await settle();
    await publish({ trackId: "audio-1", hasTrack: true, isVideo: false });
    await settle();

    expect(aspectInvocations()).toEqual([]);
    expect(mocks.setSize).not.toHaveBeenCalled();
  });
});
