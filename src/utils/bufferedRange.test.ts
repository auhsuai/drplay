// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderBufferFromBytes } from './bufferedRange';

// This app's audio streams through a custom Rust proxy (src-tauri/src/proxy.rs)
// that never populates HTMLMediaElement.buffered, so the buffer bar is driven
// exclusively by the proxy's byte accounting via `renderBufferFromBytes`.
// (getBufferedRangePct/updateBufferBar, which read `audio.buffered`, were
// removed as dead code — nothing in this app ever gets real buffered ranges.)

describe('renderBufferFromBytes', () => {
  it('renders a single segment from start/end byte ratio', () => {
    const container = document.createElement('div');
    // 25%..75% of a 1000-byte file => left 25%, width 50%.
    renderBufferFromBytes(container, 250, 750, 1000);
    expect(container.childElementCount).toBe(1);
    const seg = container.children[0] as HTMLElement;
    expect(seg.style.left).toBe('25%');
    expect(seg.style.width).toBe('50%');
  });

  it('renders from 0 when start byte is 0', () => {
    const container = document.createElement('div');
    renderBufferFromBytes(container, 0, 300, 1000);
    const seg = container.children[0] as HTMLElement;
    expect(seg.style.left).toBe('0%');
    expect(seg.style.width).toBe('30%');
  });

  it('clears the container on zero/negative total', () => {
    const container = document.createElement('div');
    renderBufferFromBytes(container, 0, 300, 1000);
    expect(container.childElementCount).toBe(1);
    renderBufferFromBytes(container, 0, 300, 0);
    expect(container.childElementCount).toBe(0);
  });

  it('clears the container when end < start', () => {
    const container = document.createElement('div');
    renderBufferFromBytes(container, 500, 300, 1000);
    expect(container.childElementCount).toBe(0);
  });

  it('reuses the single segment across calls (no child thrash)', () => {
    const container = document.createElement('div');
    renderBufferFromBytes(container, 0, 300, 1000);
    renderBufferFromBytes(container, 100, 600, 1000);
    expect(container.childElementCount).toBe(1);
    const seg = container.children[0] as HTMLElement;
    expect(seg.style.left).toBe('10%');
    expect(seg.style.width).toBe('50%');
  });

  it('null container is a no-op', () => {
    expect(() => renderBufferFromBytes(null, 0, 300, 1000)).not.toThrow();
  });
});
