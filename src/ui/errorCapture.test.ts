// @vitest-environment node
/**
 * Slice 2 — global error capture tests.
 *
 * Runs in node environment (vitest default) to avoid touching the project's
 * global test setup. We intercept the `window` object and the `captureError`
 * module via vi.mock, so no jsdom/happy-dom dependency is required.
 *
 * Cases (per slice spec):
 *  1. window.onerror handler -> captureError(source='window.onerror', message)
 *  2. unhandledrejection handler -> captureError(source='unhandledrejection', message from reason)
 *  3. ErrorBoundary.componentDidCatch -> captureError(source='ErrorBoundary') and does NOT throw
 *  4. captureError throws -> componentDidCatch still does NOT throw (no crash)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// vi.hoisted ensures the spy exists before vi.mock factory runs (hoisting).
const { captureSpy } = vi.hoisted(() => ({
  captureSpy: vi.fn(),
}));

// Intercept the errorLog module so captureError routes to our spy.
vi.mock("../utils/errorLog", () => ({
  captureError: (...args: unknown[]) => {
    captureSpy(...args);
  },
}));

// Fake window + localStorage so importing main.tsx (which imports i18n->localStorage)
// and registering global handlers works in node.
const listeners: Record<string, Array<(e: unknown) => void>> = {};
const fakeWindow = {
  addEventListener: (type: string, cb: (e: unknown) => void) => {
    (listeners[type] ??= []).push(cb);
  },
};

function setGlobal(name: string, value: unknown): void {
  (globalThis as unknown as Record<string, unknown>)[name] = value;
}

function deleteGlobal(name: string): void {
  Reflect.deleteProperty(globalThis, name);
}

beforeEach(() => {
  captureSpy.mockReset();
  captureSpy.mockResolvedValue(undefined);
  // Note: listeners persist across tests by design — main.tsx registers its
  // global handlers once (module is cached). We only reset the spy, not the
  // captured listener callbacks, so each test can fire its own event type.
  setGlobal("window", fakeWindow);
  setGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  setGlobal("document", { getElementById: () => null });
});

afterEach(() => {
  deleteGlobal("window");
  deleteGlobal("localStorage");
});

describe("global error capture", () => {
  it("window.onerror handler calls captureError with source 'window.onerror'", async () => {
    // Importing main.tsx already calls registerGlobalErrorHandlers() at load.
    await import("../main");

    const errEvent = { message: "boom", error: { stack: "stacktrace" } };
    listeners.error.forEach((cb) => {
      cb(errEvent);
    });

    expect(captureSpy).toHaveBeenCalled();
    const arg = captureSpy.mock.calls.find(
      (c) => (c[0] as { source?: string }).source === "window.onerror",
    )?.[0] as { source: string; message: string; stack?: string };
    expect(arg).toBeDefined();
    expect(arg.source).toBe("window.onerror");
    expect(arg.message).toBe("boom");
    expect(arg.stack).toBe("stacktrace");
  });

  it("unhandledrejection handler calls captureError with source 'unhandledrejection' and message from reason", async () => {
    await import("../main");

    const rejEvent = { reason: new Error("promise failed") };
    listeners.unhandledrejection.forEach((cb) => {
      cb(rejEvent);
    });

    expect(captureSpy).toHaveBeenCalled();
    const arg = captureSpy.mock.calls.find(
      (c) => (c[0] as { source?: string }).source === "unhandledrejection",
    )?.[0] as { source: string; message: string; stack?: string };
    expect(arg).toBeDefined();
    expect(arg.source).toBe("unhandledrejection");
    expect(arg.message).toBe("promise failed");
    expect(arg.stack).toBeDefined();
  });

  it("ErrorBoundary.componentDidCatch calls captureError with source 'ErrorBoundary' and does not throw", async () => {
    const { ErrorBoundary } = await import("./ErrorBoundary");
    const boundary = new ErrorBoundary({ children: null });

    const error = new Error("render boom");
    const errorInfo = { componentStack: "at Foo" };

    expect(() => {
      boundary.componentDidCatch(error, errorInfo);
    }).not.toThrow();
    expect(captureSpy).toHaveBeenCalledTimes(1);
    const arg = captureSpy.mock.calls[0][0] as {
      source: string;
      message: string;
    };
    expect(arg.source).toBe("ErrorBoundary");
    expect(arg.message).toBe("render boom");
  });

  it("captureError throwing inside componentDidCatch does NOT propagate (no crash loop)", async () => {
    captureSpy.mockRejectedValue(new Error("store down"));

    const { ErrorBoundary } = await import("./ErrorBoundary");
    const boundary = new ErrorBoundary({ children: null });

    const error = new Error("render boom");
    const errorInfo = { componentStack: "at Foo" };

    expect(() => {
      boundary.componentDidCatch(error, errorInfo);
    }).not.toThrow();
    expect(captureSpy).toHaveBeenCalledTimes(1);
  });

  it("intentional AbortError (user/code cancel) is ignored by unhandledrejection", async () => {
    await import("../main");

    const rejEvent = {
      reason: new DOMException("The user aborted a request", "AbortError"),
    };
    listeners.unhandledrejection.forEach((cb) => {
      cb(rejEvent);
    });

    const aborted = captureSpy.mock.calls.find(
      (c) => (c[0] as { source?: string }).source === "unhandledrejection",
    );
    expect(aborted).toBeUndefined();
  });

  it("AbortError caused by timeout is still logged as kind='timeout' (real failure)", async () => {
    await import("../main");

    const rejEvent = {
      reason: new DOMException(
        "The operation was aborted due to timeout",
        "AbortError",
      ),
    };
    listeners.unhandledrejection.forEach((cb) => {
      cb(rejEvent);
    });

    const arg = captureSpy.mock.calls.find(
      (c) => (c[0] as { source?: string }).source === "unhandledrejection",
    )?.[0] as { kind: string; level: string };
    expect(arg).toBeDefined();
    expect(arg.kind).toBe("timeout");
    expect(arg.level).toBe("warn");
  });

  it("intentional AbortError is ignored by window.onerror", async () => {
    await import("../main");

    const errEvent = {
      message: "The user aborted a request",
      error: new DOMException("The user aborted a request", "AbortError"),
    };
    listeners.error.forEach((cb) => {
      cb(errEvent);
    });

    const aborted = captureSpy.mock.calls.find(
      (c) => (c[0] as { source?: string }).source === "window.onerror",
    );
    expect(aborted).toBeUndefined();
  });
});
