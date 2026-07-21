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

  // Regression coverage for MoreMenu.tsx, whose trigger button and dropdown
  // panel are two separate elements — a click on either must NOT count as
  // "outside", only a click landing on neither.
  describe('with an array of refs (MoreMenu-style: button + separately positioned panel)', () => {
    function setup() {
      const button = document.createElement('button');
      const panel = document.createElement('div');
      const outside = document.createElement('div');
      document.body.appendChild(button);
      document.body.appendChild(panel);
      document.body.appendChild(outside);
      return { button, panel, outside };
    }

    it('does not call onOutside for a click inside the first ref (button)', () => {
      const { button, panel, outside } = setup();
      const onOutside = vi.fn();
      renderHook(() => {
        const buttonRef = useRef(button);
        const panelRef = useRef(panel);
        useClickOutside([buttonRef, panelRef], true, onOutside);
      });

      fireMouseDown(button);
      expect(onOutside).not.toHaveBeenCalled();

      [button, panel, outside].forEach((el) => document.body.removeChild(el));
    });

    it('does not call onOutside for a click inside the second ref (panel)', () => {
      const { button, panel, outside } = setup();
      const onOutside = vi.fn();
      renderHook(() => {
        const buttonRef = useRef(button);
        const panelRef = useRef(panel);
        useClickOutside([buttonRef, panelRef], true, onOutside);
      });

      fireMouseDown(panel);
      expect(onOutside).not.toHaveBeenCalled();

      [button, panel, outside].forEach((el) => document.body.removeChild(el));
    });

    it('calls onOutside for a click outside BOTH refs', () => {
      const { button, panel, outside } = setup();
      const onOutside = vi.fn();
      renderHook(() => {
        const buttonRef = useRef(button);
        const panelRef = useRef(panel);
        useClickOutside([buttonRef, panelRef], true, onOutside);
      });

      fireMouseDown(outside);
      expect(onOutside).toHaveBeenCalledTimes(1);

      [button, panel, outside].forEach((el) => document.body.removeChild(el));
    });

    it('does not re-add the listener (no duplicate firing) when the caller passes a fresh array literal every render, matching the real MoreMenu call site', () => {
      const { button, panel, outside } = setup();
      const onOutside = vi.fn();
      const { rerender } = renderHook(
        ({ n }: { n: number }) => {
          const buttonRef = useRef(button);
          const panelRef = useRef(panel);
          // Fresh `[buttonRef, panelRef]` array literal every render, as a
          // real inline call site would produce.
          useClickOutside([buttonRef, panelRef], true, () => onOutside(n));
        },
        { initialProps: { n: 1 } },
      );

      rerender({ n: 2 });
      rerender({ n: 3 });

      fireMouseDown(outside);

      // Exactly one call (not 3, which would mean a fresh listener was
      // stacked on top of prior ones each render), and reflecting the
      // latest render's callback.
      expect(onOutside).toHaveBeenCalledTimes(1);
      expect(onOutside).toHaveBeenCalledWith(3);

      [button, panel, outside].forEach((el) => document.body.removeChild(el));
    });
  });
});
