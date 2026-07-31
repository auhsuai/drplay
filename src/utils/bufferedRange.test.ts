// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { updateBufferBar } from './bufferedRange';

function makeAudio(opts: {
  duration: number;
  currentTime: number;
  ranges: Array<[number, number]>;
}): HTMLMediaElement {
  const buffered: TimeRanges = {
    length: opts.ranges.length,
    start: (i: number) => opts.ranges[i][0],
    end: (i: number) => opts.ranges[i][1],
  } as unknown as TimeRanges;

  return {
    duration: opts.duration,
    currentTime: opts.currentTime,
    buffered,
  } as unknown as HTMLMediaElement;
}

describe('updateBufferBar', () => {
  const DUR = 1000;

  it('single contiguous range renders one correctly-positioned segment', () => {
    const container = document.createElement('div');
    const audio = makeAudio({ duration: DUR, currentTime: 10, ranges: [[0, 30]] });
    updateBufferBar(container, audio);
    expect(container.childElementCount).toBe(1);
    const seg = container.children[0] as HTMLElement;
    expect(seg.style.left).toBe('0%');
    expect(seg.style.width).toBe(`${(30 / DUR) * 100}%`);
  });

  it('forward seek with non-contiguous ranges renders BOTH segments', () => {
    const container = document.createElement('div');
    const audio = makeAudio({ duration: DUR, currentTime: 505, ranges: [[0, 30], [500, 510]] });
    updateBufferBar(container, audio);
    // Both the old [0,30] and the new [500,510] region are shown.
    expect(container.childElementCount).toBe(2);
    const first = container.children[0] as HTMLElement;
    const second = container.children[1] as HTMLElement;
    expect(first.style.left).toBe('0%');
    expect(first.style.width).toBe(`${(30 / DUR) * 100}%`);
    expect(second.style.left).toBe(`${(500 / DUR) * 100}%`);
    expect(second.style.width).toBe(`${(10 / DUR) * 100}%`);
  });

  it('shrinking range count removes extra segments', () => {
    const container = document.createElement('div');
    const two = makeAudio({ duration: DUR, currentTime: 505, ranges: [[0, 30], [500, 510]] });
    updateBufferBar(container, two);
    expect(container.childElementCount).toBe(2);
    const one = makeAudio({ duration: DUR, currentTime: 10, ranges: [[0, 30]] });
    updateBufferBar(container, one);
    expect(container.childElementCount).toBe(1);
  });

  it('empty buffered data clears the container', () => {
    const container = document.createElement('div');
    const two = makeAudio({ duration: DUR, currentTime: 505, ranges: [[0, 30], [500, 510]] });
    updateBufferBar(container, two);
    expect(container.childElementCount).toBe(2);
    const empty = makeAudio({ duration: DUR, currentTime: 0, ranges: [] });
    updateBufferBar(container, empty);
    expect(container.childElementCount).toBe(0);
  });

  it('invalid duration clears the container', () => {
    const container = document.createElement('div');
    const two = makeAudio({ duration: DUR, currentTime: 505, ranges: [[0, 30], [500, 510]] });
    updateBufferBar(container, two);
    const bad = makeAudio({ duration: NaN, currentTime: 10, ranges: [[0, 30]] });
    updateBufferBar(container, bad);
    expect(container.childElementCount).toBe(0);
  });

  it('null container is a no-op', () => {
    const audio = makeAudio({ duration: DUR, currentTime: 10, ranges: [[0, 30]] });
    expect(() => updateBufferBar(null, audio)).not.toThrow();
  });
});
