// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useErrorDisplay } from './useErrorDisplay';

const driveQuotaError = {
  type: 'drive_quota_exceeded',
  text: 'Drive quota exceeded',
};

describe('useErrorDisplay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('slides in, dismisses, and clears the error after the transition', () => {
    const dispatch = vi.fn();
    const { result } = renderHook(() => useErrorDisplay({
      errorInfo: driveQuotaError,
      dispatch,
      rateLimitUntilRef: { current: 0 },
    }));

    expect(result.current.toastSlideIn).toBe(false);
    act(() => vi.advanceTimersByTime(10));
    expect(result.current.toastSlideIn).toBe(true);

    act(() => result.current.dismissToast());
    expect(result.current.toastSlideIn).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(300));
    expect(dispatch).toHaveBeenCalledWith({ type: 'CLEAR_ERROR' });
  });

  it('cancels pending timers on unmount', () => {
    const dispatch = vi.fn();
    const { unmount } = renderHook(() => useErrorDisplay({
      errorInfo: driveQuotaError,
      dispatch,
      rateLimitUntilRef: { current: 0 },
    }));

    unmount();
    act(() => vi.runAllTimers());
    expect(dispatch).not.toHaveBeenCalled();
  });
});
