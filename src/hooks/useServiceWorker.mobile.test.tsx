// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useServiceWorker } from "./useServiceWorker";

const platformMock = vi.hoisted(() => ({ IS_MOBILE: true }));
vi.mock("../utils/platform", () => ({ IS_MOBILE: platformMock.IS_MOBILE }));

vi.mock("../utils/errorLog", () => ({
  captureError: vi.fn(),
}));

type Listener = EventListenerOrEventListenerObject;

interface MockServiceWorker {
  register: ReturnType<typeof vi.fn>;
  ready: Promise<{ active: { postMessage: ReturnType<typeof vi.fn> } }>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  listeners: Set<Listener>;
}

// Same observable ServiceWorkerContainer stand-in as useServiceWorker.test.ts
// (GATE B: wry#1710 — SW registration is dead on Tauri Android, so the hook
// must not touch the container at all on mobile).
function installServiceWorkerMock(): MockServiceWorker {
  const listeners = new Set<Listener>();
  const sw = {
    register: vi.fn().mockResolvedValue({ active: null }),
    ready: Promise.resolve({ active: { postMessage: vi.fn() } }),
    addEventListener: vi.fn((_type: string, handler: Listener) => {
      listeners.add(handler);
    }),
    removeEventListener: vi.fn((_type: string, handler: Listener) => {
      listeners.delete(handler);
    }),
    listeners,
  };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    writable: true,
    value: sw,
  });
  return sw;
}

beforeEach(() => {
  vi.clearAllMocks();
  platformMock.IS_MOBILE = true;
});

afterEach(() => {
  platformMock.IS_MOBILE = true;
});

describe("useServiceWorker mobile (IS_MOBILE — SW dead on Tauri Android, no attempt, no error log)", () => {
  it("never registers the service worker", () => {
    const sw = installServiceWorkerMock();

    renderHook(() => {
      useServiceWorker();
    });

    expect(sw.register).not.toHaveBeenCalled();
  });

  it("attaches no SW container listeners (no controllerchange/message)", () => {
    const sw = installServiceWorkerMock();

    renderHook(() => {
      useServiceWorker();
    });

    expect(sw.listeners.size).toBe(0);
  });

  it("unmounts without touching the SW container", () => {
    const sw = installServiceWorkerMock();

    const { unmount } = renderHook(() => {
      useServiceWorker();
    });
    unmount();

    expect(sw.removeEventListener).not.toHaveBeenCalled();
    expect(sw.register).not.toHaveBeenCalled();
  });

  it("does not push a token through the SW on mount (login path)", async () => {
    const sw = installServiceWorkerMock();

    renderHook(() => {
      useServiceWorker("tok-A");
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(sw.register).not.toHaveBeenCalled();
  });
});
