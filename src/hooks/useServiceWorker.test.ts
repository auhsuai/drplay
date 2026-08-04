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

interface MockServiceWorker {
  register: ReturnType<typeof vi.fn>;
  controller: ServiceWorker | null;
  ready: Promise<{ active: ServiceWorker | null }>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  listeners: Set<Listener>;
  worker: { postMessage: ReturnType<typeof vi.fn> };
}

// jsdom does not implement navigator.serviceWorker — install an observable
// stand-in that mimics EventTarget identity semantics (removeEventListener only
// removes the exact handler reference that was added), so leaked listeners stay
// in the Set and fail the size assertions below. `ready` resolves to a worker
// whose postMessage is observable, mirroring the real
// ServiceWorkerContainer.ready contract.
function installServiceWorkerMock(): MockServiceWorker {
  const listeners = new Set<Listener>();
  const worker = { postMessage: vi.fn() };
  const sw = {
    register: vi.fn().mockResolvedValue({ active: null }),
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

    const { unmount } = renderHook(() => useServiceWorker());

    expect(sw.addEventListener).toHaveBeenCalledWith(
      "controllerchange",
      expect.any(Function),
    );
    const handler = sw.addEventListener.mock.calls[0]![1];
    // Two SW-container listeners are now expected: controllerchange + the
    // message listener used for SW_TOKEN_EXPIRED recovery (B3).
    expect(sw.listeners.size).toBe(2);

    await act(async () => {});
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

    const first = renderHook(() => useServiceWorker());
    await act(async () => {});
    first.unmount();
    expect(sw.listeners.size).toBe(0);

    const second = renderHook(() => useServiceWorker());
    await act(async () => {});
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

    renderHook(() => useServiceWorker("tok-A"));
    await act(async () => {});

    expect(sw.worker.postMessage).toHaveBeenCalledWith({
      type: "UPDATE_TOKEN",
      token: "tok-A",
    });
  });

  it("re-pushes UPDATE_TOKEN when the token prop changes (refresh/login)", async () => {
    const sw = installServiceWorkerMock();
    gateRegister(sw);

    const { rerender } = renderHook(
      (props: { token: string | null }) => useServiceWorker(props.token),
      { initialProps: { token: "tok-A" } as { token: string | null } },
    );
    await act(async () => {});
    rerender({ token: "tok-B" });
    await act(async () => {});

    expect(sw.worker.postMessage).toHaveBeenCalledWith({
      type: "UPDATE_TOKEN",
      token: "tok-B",
    });
  });

  it("pushes an empty token when the token prop becomes null (logout clears the SW token)", async () => {
    const sw = installServiceWorkerMock();
    gateRegister(sw);

    const { rerender } = renderHook(
      (props: { token: string | null }) => useServiceWorker(props.token),
      { initialProps: { token: "tok-A" } as { token: string | null } },
    );
    await act(async () => {});
    rerender({ token: null });
    await act(async () => {});

    expect(sw.worker.postMessage).toHaveBeenCalledWith({
      type: "UPDATE_TOKEN",
      token: "",
    });
  });

  it("captures a rejected ready promise as a warn instead of crashing", async () => {
    const sw = installServiceWorkerMock();
    gateRegister(sw);
    sw.ready = Promise.reject(new Error("ready rejected"));

    renderHook(() => useServiceWorker("tok-A"));
    await act(async () => {});

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
