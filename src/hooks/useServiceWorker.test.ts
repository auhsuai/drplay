// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useServiceWorker } from './useServiceWorker';

type Listener = EventListenerOrEventListenerObject;

interface MockServiceWorker {
  register: ReturnType<typeof vi.fn>;
  controller: ServiceWorker | null;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  listeners: Set<Listener>;
}

// jsdom does not implement navigator.serviceWorker — install an observable
// stand-in that mimics EventTarget identity semantics (removeEventListener only
// removes the exact handler reference that was added), so leaked listeners stay
// in the Set and fail the size assertions below.
function installServiceWorkerMock(): MockServiceWorker {
  const listeners = new Set<Listener>();
  const sw = {
    register: vi.fn().mockResolvedValue({ active: null }),
    controller: null,
    addEventListener: vi.fn((_type: string, handler: Listener) => {
      listeners.add(handler);
    }),
    removeEventListener: vi.fn((_type: string, handler: Listener) => {
      listeners.delete(handler);
    }),
    listeners,
  };
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    writable: true,
    value: sw,
  });
  return sw;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useServiceWorker controllerchange listener lifecycle', () => {
  it('removes the controllerchange listener when the component unmounts', async () => {
    const sw = installServiceWorkerMock();

    const { unmount } = renderHook(() => useServiceWorker());

    expect(sw.addEventListener).toHaveBeenCalledWith('controllerchange', expect.any(Function));
    const handler = sw.addEventListener.mock.calls[0]![1];
    expect(sw.listeners.size).toBe(1);

    await act(async () => {});
    unmount();

    // The SAME handler reference must be passed to removeEventListener;
    // EventTarget.removeEventListener is identity-based and a fresh anonymous
    // function would silently fail to detach the listener.
    expect(sw.removeEventListener).toHaveBeenCalledWith('controllerchange', handler);
    expect(sw.listeners.size).toBe(0);
  });

  it('does not accumulate listeners across mount/unmount cycles (remount regression)', async () => {
    const sw = installServiceWorkerMock();

    const first = renderHook(() => useServiceWorker());
    await act(async () => {});
    first.unmount();
    expect(sw.listeners.size).toBe(0);

    const second = renderHook(() => useServiceWorker());
    await act(async () => {});
    expect(sw.listeners.size).toBe(1);

    second.unmount();
    expect(sw.addEventListener).toHaveBeenCalledTimes(2);
    expect(sw.listeners.size).toBe(0);
  });
});
