// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureError } from "../utils/errorLog";
import { useServiceWorker } from "./useServiceWorker";

vi.mock("../utils/errorLog", () => ({
  captureError: vi.fn(),
}));

const mockedCaptureError = vi.mocked(captureError);

type Listener = EventListenerOrEventListenerObject;

interface MockRegistration {
  active: ServiceWorker | null;
  installing: ServiceWorker | null;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
}

interface MockServiceWorker {
  register: ReturnType<typeof vi.fn>;
  controller: ServiceWorker | null;
  ready: Promise<{ active: ServiceWorker | null }>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  listeners: Set<Listener>;
  worker: { postMessage: ReturnType<typeof vi.fn> };
  registration: MockRegistration;
  regListeners: Set<Listener>;
}

// jsdom does not implement navigator.serviceWorker — install an observable
// stand-in that mimics EventTarget identity semantics (removeEventListener only
// removes the exact handler reference that was added), so leaked listeners stay
// in the Set and fail the size assertions below. `ready` resolves to a worker
// whose postMessage is observable, mirroring the real
// ServiceWorkerContainer.ready contract.
function installServiceWorkerMock(): MockServiceWorker {
  const listeners = new Set<Listener>();
  const regListeners = new Set<Listener>();
  const worker = { postMessage: vi.fn() };
  // Registration-level listener set: observable identity-based EventTarget
  // stand-in so updatefound leaks show up as leftover Set entries.
  const registration: MockRegistration = {
    active: null,
    installing: null,
    addEventListener: vi.fn((_type: string, handler: Listener) => {
      regListeners.add(handler);
    }),
    removeEventListener: vi.fn((_type: string, handler: Listener) => {
      regListeners.delete(handler);
    }),
  };
  const sw = {
    register: vi.fn().mockResolvedValue(registration),
    controller: null,
    ready: Promise.resolve({ active: worker as unknown as ServiceWorker }),
    addEventListener: vi.fn((_type: string, handler: Listener) => {
      listeners.add(handler);
    }),
    removeEventListener: vi.fn((_type: string, handler: Listener) => {
      listeners.delete(handler);
    }),
    listeners,
    worker,
    registration,
    regListeners,
  };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    writable: true,
    value: sw,
  });
  return sw;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useServiceWorker controllerchange listener lifecycle", () => {
  it("removes the controllerchange listener when the component unmounts", async () => {
    const sw = installServiceWorkerMock();

    const { unmount } = renderHook(() => {
      useServiceWorker();
    });

    expect(sw.addEventListener).toHaveBeenCalledWith(
      "controllerchange",
      expect.any(Function),
    );
    const firstCall = sw.addEventListener.mock.calls[0];
    if (firstCall === undefined)
      throw new Error("expected addEventListener call");
    const handler = firstCall[1] as Listener;
    // Two SW-container listeners are now expected: controllerchange + the
    // message listener used for SW_TOKEN_EXPIRED recovery (B3).
    expect(sw.listeners.size).toBe(2);

    await act(async () => {
      await Promise.resolve();
    });
    unmount();

    // The SAME handler reference must be passed to removeEventListener;
    // EventTarget.removeEventListener is identity-based and a fresh anonymous
    // function would silently fail to detach the listener.
    expect(sw.removeEventListener).toHaveBeenCalledWith(
      "controllerchange",
      handler,
    );
    expect(sw.listeners.size).toBe(0);
  });

  it("does not accumulate listeners across mount/unmount cycles (remount regression)", async () => {
    const sw = installServiceWorkerMock();

    const first = renderHook(() => {
      useServiceWorker();
    });
    await act(async () => {
      await Promise.resolve();
    });
    first.unmount();
    expect(sw.listeners.size).toBe(0);

    const second = renderHook(() => {
      useServiceWorker();
    });
    await act(async () => {
      await Promise.resolve();
    });
    // controllerchange + message (B3) = 2 listeners per mounted hook.
    expect(sw.listeners.size).toBe(2);

    second.unmount();
    // Two mount cycles x (controllerchange + message) = 4 registrations.
    expect(sw.addEventListener).toHaveBeenCalledTimes(4);
    expect(sw.listeners.size).toBe(0);
  });
});

describe("useServiceWorker token watcher (login/refresh/logout push)", () => {
  // The mount-time register()→ready push already ran pre-login with an empty
  // token (the production race this fix targets). Gate register() so the
  // post-login push cannot ride the pre-existing register chain — the token
  // watcher must push purely off the token prop.
  function gateRegister(sw: MockServiceWorker): void {
    sw.register.mockRejectedValue(
      new Error("simulated: register-time push already ran pre-login"),
    );
  }

  it("pushes UPDATE_TOKEN with the provided token on mount (login path)", async () => {
    const sw = installServiceWorkerMock();
    gateRegister(sw);

    renderHook(() => {
      useServiceWorker("tok-A");
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(sw.worker.postMessage).toHaveBeenCalledWith({
      type: "UPDATE_TOKEN",
      token: "tok-A",
    });
  });

  it("re-pushes UPDATE_TOKEN when the token prop changes (refresh/login)", async () => {
    const sw = installServiceWorkerMock();
    gateRegister(sw);

    const initialProps: { token: string | null } = { token: "tok-A" };
    const { rerender } = renderHook(
      (props: { token: string | null }) => {
        useServiceWorker(props.token);
      },
      { initialProps },
    );
    await act(async () => {
      await Promise.resolve();
    });
    rerender({ token: "tok-B" });
    await act(async () => {
      await Promise.resolve();
    });

    expect(sw.worker.postMessage).toHaveBeenCalledWith({
      type: "UPDATE_TOKEN",
      token: "tok-B",
    });
  });

  it("pushes an empty token when the token prop becomes null (logout clears the SW token)", async () => {
    const sw = installServiceWorkerMock();
    gateRegister(sw);

    const initialProps: { token: string | null } = { token: "tok-A" };
    const { rerender } = renderHook(
      (props: { token: string | null }) => {
        useServiceWorker(props.token);
      },
      { initialProps },
    );
    await act(async () => {
      await Promise.resolve();
    });
    rerender({ token: null });
    await act(async () => {
      await Promise.resolve();
    });

    expect(sw.worker.postMessage).toHaveBeenCalledWith({
      type: "UPDATE_TOKEN",
      token: "",
    });
  });

  it("captures a rejected ready promise as a warn instead of crashing", async () => {
    const sw = installServiceWorkerMock();
    gateRegister(sw);
    sw.ready = Promise.reject(new Error("ready rejected"));

    renderHook(() => {
      useServiceWorker("tok-A");
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockedCaptureError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        source: "useServiceWorker",
        message: expect.stringContaining(
          "sw-token-push-failed",
        ) as unknown as string,
      }),
    );
  });
});

describe("useServiceWorker updatefound listener lifecycle (B15-2)", () => {
  it("registers exactly ONE updatefound listener across 3 token changes", async () => {
    const sw = installServiceWorkerMock();

    const initialProps: { token: string | null } = { token: "tok-A" };
    const { rerender } = renderHook(
      (props: { token: string | null }) => {
        useServiceWorker(props.token);
      },
      { initialProps },
    );
    await act(async () => {
      await Promise.resolve();
    });

    rerender({ token: "tok-B" });
    await act(async () => {
      await Promise.resolve();
    });
    rerender({ token: "tok-C" });
    await act(async () => {
      await Promise.resolve();
    });

    // The lifecycle effect is mount-only: a token refresh must not re-register
    // (register() returns the SAME registration object per SW spec).
    expect(sw.register).toHaveBeenCalledTimes(1);
    const updateFoundCalls = sw.registration.addEventListener.mock.calls.filter(
      (call) => call[0] === "updatefound",
    );
    expect(updateFoundCalls).toHaveLength(1);
    expect(sw.regListeners.size).toBe(1);
  });

  it("removes the updatefound listener (same reference) on unmount", async () => {
    const sw = installServiceWorkerMock();
    const { unmount } = renderHook(() => {
      useServiceWorker();
    });
    await act(async () => {
      await Promise.resolve();
    });

    const added = sw.registration.addEventListener.mock.calls.find(
      (call) => call[0] === "updatefound",
    );
    if (added === undefined) throw new Error("expected updatefound listener");
    const handler = added[1] as Listener;

    unmount();

    expect(sw.registration.removeEventListener).toHaveBeenCalledWith(
      "updatefound",
      handler,
    );
    expect(sw.regListeners.size).toBe(0);
  });

  it("pushes the LATEST token when a SW update activates (ref, not the mount-time closure)", async () => {
    const sw = installServiceWorkerMock();
    const initialProps: { token: string | null } = { token: "tok-A" };
    const { rerender } = renderHook(
      (props: { token: string | null }) => {
        useServiceWorker(props.token);
      },
      { initialProps },
    );
    await act(async () => {
      await Promise.resolve();
    });
    rerender({ token: "tok-C" });
    await act(async () => {
      await Promise.resolve();
    });

    const added = sw.registration.addEventListener.mock.calls.find(
      (call) => call[0] === "updatefound",
    );
    if (added === undefined) throw new Error("expected updatefound listener");
    const onUpdateFound = added[1] as () => void;

    let onStateChange: (() => void) | null = null;
    const newWorker = {
      state: "installing",
      postMessage: vi.fn(),
      addEventListener: vi.fn((_type: string, handler: () => void) => {
        onStateChange = handler;
      }),
    };
    sw.registration.installing = newWorker as unknown as ServiceWorker;

    act(() => {
      onUpdateFound();
    });
    act(() => {
      newWorker.state = "activated";
      onStateChange?.();
    });

    expect(newWorker.postMessage).toHaveBeenCalledWith({
      type: "UPDATE_TOKEN",
      token: "tok-C",
    });
  });
});

describe("useServiceWorker token read resilience (B15-5)", () => {
  it("logs sw-access-token-read-failed and never throws when localStorage.getItem throws", async () => {
    const sw = installServiceWorkerMock();
    const getItemSpy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new DOMException("storage denied", "SecurityError");
      });

    const { unmount } = renderHook(() => {
      useServiceWorker(null);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockedCaptureError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        source: "useServiceWorker",
        message: expect.stringContaining(
          "sw-access-token-read-failed:SecurityError",
        ) as unknown as string,
      }),
    );

    // controllerchange handler path: same guarded read (raw getItem would
    // throw uncaught inside the event listener).
    const controllerChange = sw.addEventListener.mock.calls.find(
      (call) => call[0] === "controllerchange",
    );
    if (controllerChange === undefined)
      throw new Error("expected controllerchange listener");
    const handler = controllerChange[1] as () => void;
    expect(() => {
      handler();
    }).not.toThrow();

    getItemSpy.mockRestore();
    unmount();
  });
});
