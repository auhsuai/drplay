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
    expect(seg.style.left).toBe(`${(10 / DUR) * 100}%`);
    expect(seg.style.width).toBe(`${(20 / DUR) * 100}%`);
  });

  it('BUG regression: backward seek drops the already-played part of the buffered range', () => {
    const container = document.createElement('div');
    const audio = makeAudio({ duration: 900, currentTime: 420, ranges: [[0, 900]] });
    updateBufferBar(container, audio);
    // Browser still reports the full [0,900] after a backward seek, but the bar
    // must only show the future part [420,900] — otherwise it looks stuck.
    expect(container.childElementCount).toBe(1);
    const seg = container.children[0] as HTMLElement;
    expect(seg.style.left).toBe(`${(420 / 900) * 100}%`);
    expect(seg.style.width).toBe(`${((900 - 420) / 900) * 100}%`);
  });

  it('BUG regression: fully-past ranges are dropped, crossing ranges are clipped to currentTime', () => {
    const container = document.createElement('div');
    const audio = makeAudio({ duration: DUR, currentTime: 60, ranges: [[0, 30], [50, 200]] });
    updateBufferBar(container, audio);
    // [0,30] ends before currentTime -> dropped; [50,200] -> clipped to [60,200].
    expect(container.childElementCount).toBe(1);
    const seg = container.children[0] as HTMLElement;
    expect(seg.style.left).toBe(`${(60 / DUR) * 100}%`);
    expect(seg.style.width).toBe(`${(140 / DUR) * 100}%`);
  });

  it('BUG regression: no visible segments remain when every buffered range is in the past', () => {
    const container = document.createElement('div');
    const audio = makeAudio({ duration: DUR, currentTime: 500, ranges: [[0, 100], [200, 300]] });
    updateBufferBar(container, audio);
    expect(container.childElementCount).toBe(0);
  });

  it('forward seek with non-contiguous ranges renders only the future segment', () => {
    const container = document.createElement('div');
    const audio = makeAudio({ duration: DUR, currentTime: 505, ranges: [[0, 30], [500, 510]] });
    updateBufferBar(container, audio);
    // The pre-seek [0,30] region is fully in the past now; [500,510] is
    // clipped to currentTime=505, so only [505,510] shows.
    expect(container.childElementCount).toBe(1);
    const seg = container.children[0] as HTMLElement;
    expect(seg.style.left).toBe(`${(505 / DUR) * 100}%`);
    expect(seg.style.width).toBe(`${(5 / DUR) * 100}%`);
  });

  it('shrinking visible segment count removes extra segments', () => {
    const container = document.createElement('div');
    const two = makeAudio({ duration: DUR, currentTime: 5, ranges: [[0, 30], [4, 200]] });
    updateBufferBar(container, two);
    expect(container.childElementCount).toBe(2);
    const one = makeAudio({ duration: DUR, currentTime: 60, ranges: [[0, 30], [50, 200]] });
    updateBufferBar(container, one);
    expect(container.childElementCount).toBe(1);
  });

  it('empty buffered data clears the container', () => {
    const container = document.createElement('div');
    const two = makeAudio({ duration: DUR, currentTime: 5, ranges: [[0, 30], [4, 200]] });
    updateBufferBar(container, two);
    expect(container.childElementCount).toBe(2);
    const empty = makeAudio({ duration: DUR, currentTime: 0, ranges: [] });
    updateBufferBar(container, empty);
    expect(container.childElementCount).toBe(0);
  });

  it('invalid duration clears the container', () => {
    const container = document.createElement('div');
    const two = makeAudio({ duration: DUR, currentTime: 5, ranges: [[0, 30], [4, 200]] });
    updateBufferBar(container, two);
    const bad = makeAudio({ duration: NaN, currentTime: 10, ranges: [[0, 30]] });
    updateBufferBar(container, bad);
    expect(container.childElementCount).toBe(0);
  });

  it('null container is a no-op', () => {
    const audio = makeAudio({ duration: DUR, currentTime: 10, ranges: [[0, 30]] });
    expect(() => updateBufferBar(null, audio)).not.toThrow();
  });

  it('BUG regression (round 2): stale pre-seek range fully ahead of the playhead is dropped', () => {
    const container = document.createElement('div');
    const audio = makeAudio({ duration: 900, currentTime: 420, ranges: [[720, 750]] });
    updateBufferBar(container, audio);
    // [12:00,12:30] was buffered before seeking back to 7:00; it sits entirely
    // ahead of the playhead, so rendering it would show a phantom segment at
    // the old position instead of the buffer at the new one.
    expect(container.childElementCount).toBe(0);
  });

  it('BUG regression (round 2): range starting exactly at the playhead renders one segment', () => {
    const container = document.createElement('div');
    const audio = makeAudio({ duration: 900, currentTime: 420, ranges: [[420, 450]] });
    updateBufferBar(container, audio);
    expect(container.childElementCount).toBe(1);
    const seg = container.children[0] as HTMLElement;
    expect(seg.style.left).toBe(`${(420 / 900) * 100}%`);
    expect(seg.style.width).toBe(`${((450 - 420) / 900) * 100}%`);
  });

  it('BUG regression (round 2): contiguous range spanning the playhead still renders the future part', () => {
    const container = document.createElement('div');
    const audio = makeAudio({ duration: 900, currentTime: 420, ranges: [[0, 900]] });
    updateBufferBar(container, audio);
    expect(container.childElementCount).toBe(1);
    const seg = container.children[0] as HTMLElement;
    expect(seg.style.left).toBe(`${(420 / 900) * 100}%`);
    expect(seg.style.width).toBe(`${((900 - 420) / 900) * 100}%`);
  });
});
