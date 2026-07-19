// @vitest-environment jsdom
import { renderHook, act, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useScrollVelocity } from '../useScrollVelocity';

describe('useScrollVelocity', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    cleanup();
  });

  function makeRef(el: HTMLElement | null) {
    return { current: el } as React.RefObject<HTMLElement>;
  }

  function fireScroll(el: HTMLElement, top: number) {
    return act(async () => {
      Object.defineProperty(el, 'scrollTop', { value: top, configurable: true });
      el.dispatchEvent(new Event('scroll'));
      await new Promise((r) => setTimeout(r, 20));
    });
  }

  it('returns slow margin (3) when no scroll events fire', () => {
    const el = document.createElement('div');
    const ref = makeRef(el);
    const { result } = renderHook(() => useScrollVelocity(ref));
    expect(result.current.velocity).toBe(0);
    expect(result.current.dynamicMargin).toBe(3);
  });

  it('maps low velocity (>0, <=40) to margin 3', async () => {
    const el = document.createElement('div');
    const ref = makeRef(el);
    const { result } = renderHook(() => useScrollVelocity(ref));
    await fireScroll(el, 20);
    expect(result.current.dynamicMargin).toBe(3);
  });

  it('maps medium velocity (>40, <=100) to margin 6', async () => {
    const el = document.createElement('div');
    const ref = makeRef(el);
    const { result } = renderHook(() => useScrollVelocity(ref));
    await fireScroll(el, 60);
    expect(result.current.dynamicMargin).toBe(6);
  });

  it('maps fast velocity (>100) to margin 12', async () => {
    const el = document.createElement('div');
    const ref = makeRef(el);
    const { result } = renderHook(() => useScrollVelocity(ref));
    await fireScroll(el, 150);
    expect(result.current.dynamicMargin).toBe(12);
  });

  it('cleans up listener and rAF on unmount', () => {
    const removeSpy = vi.spyOn(HTMLElement.prototype, 'removeEventListener');
    const el = document.createElement('div');
    const ref = makeRef(el);
    const { unmount } = renderHook(() => useScrollVelocity(ref));
    unmount();
    expect(removeSpy).toHaveBeenCalledWith('scroll', expect.any(Function));
    removeSpy.mockRestore();
  });
});
