// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { useClickOutside } from './useClickOutside';

function fireMouseDown(target: Element) {
  const event = new MouseEvent('mousedown', { bubbles: true });
  target.dispatchEvent(event);
}

describe('useClickOutside', () => {
  it('calls onOutside when mousedown happens outside the ref element', () => {
    const inside = document.createElement('div');
    const outside = document.createElement('div');
    document.body.appendChild(inside);
    document.body.appendChild(outside);

    const onOutside = vi.fn();
    renderHook(() => {
      const ref = useRef(inside);
      useClickOutside(ref, true, onOutside);
    });

    fireMouseDown(outside);
    expect(onOutside).toHaveBeenCalledTimes(1);

    document.body.removeChild(inside);
    document.body.removeChild(outside);
  });

  it('does not call onOutside when mousedown happens inside the ref element', () => {
    const inside = document.createElement('div');
    const child = document.createElement('span');
    inside.appendChild(child);
    document.body.appendChild(inside);

    const onOutside = vi.fn();
    renderHook(() => {
      const ref = useRef(inside);
      useClickOutside(ref, true, onOutside);
    });

    fireMouseDown(child);
    expect(onOutside).not.toHaveBeenCalled();

    document.body.removeChild(inside);
  });

  it('does not attach any listener when active is false', () => {
    const inside = document.createElement('div');
    const outside = document.createElement('div');
    document.body.appendChild(inside);
    document.body.appendChild(outside);

    const onOutside = vi.fn();
    renderHook(() => {
      const ref = useRef(inside);
      useClickOutside(ref, false, onOutside);
    });

    fireMouseDown(outside);
    expect(onOutside).not.toHaveBeenCalled();

    document.body.removeChild(inside);
    document.body.removeChild(outside);
  });

  it('always calls the LATEST onOutside even when passed a fresh inline callback every render, without re-adding the listener', () => {
    const inside = document.createElement('div');
    const outside = document.createElement('div');
    document.body.appendChild(inside);
    document.body.appendChild(outside);

    const calls: number[] = [];
    const { rerender } = renderHook(
      ({ n }: { n: number }) => {
        const ref = useRef(inside);
        // A fresh inline closure every render, matching real call sites like
        // `useClickOutside(ref, isOpen, () => setIsOpen(false))`.
        useClickOutside(ref, true, () => calls.push(n));
      },
      { initialProps: { n: 1 } },
    );

    rerender({ n: 2 });
    rerender({ n: 3 });

    fireMouseDown(outside);

    // Must reflect the LATEST render's callback (n=3), not a stale one
    // captured from the first render.
    expect(calls).toEqual([3]);

    document.body.removeChild(inside);
    document.body.removeChild(outside);
  });

  it('stops calling onOutside after active flips back to false', () => {
    const inside = document.createElement('div');
    const outside = document.createElement('div');
    document.body.appendChild(inside);
    document.body.appendChild(outside);

    const onOutside = vi.fn();
    const { rerender } = renderHook(
      ({ active }: { active: boolean }) => {
        const ref = useRef(inside);
        useClickOutside(ref, active, onOutside);
      },
      { initialProps: { active: true } },
    );

    rerender({ active: false });
    fireMouseDown(outside);
    expect(onOutside).not.toHaveBeenCalled();

    document.body.removeChild(inside);
    document.body.removeChild(outside);
  });
});
