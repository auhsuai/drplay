// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { updateBufferBar } from "./bufferedRange";

function makeAudio(opts: {
  duration: number;
  currentTime: number;
  ranges: Array<[number, number]>;
}): HTMLMediaElement {
  const buffered: TimeRanges = {
    length: opts.ranges.length,
    start: (i: number) => opts.ranges[i]?.[0] ?? 0,
    end: (i: number) => opts.ranges[i]?.[1] ?? 0,
  };

  return {
    duration: opts.duration,
    currentTime: opts.currentTime,
    buffered,
  } as unknown as HTMLMediaElement;
}

describe("updateBufferBar", () => {
  const DUR = 1000;

  it("single contiguous range renders one correctly-positioned segment spanning its full range", () => {
    const container = document.createElement("div");
    const audio = makeAudio({
      duration: DUR,
      currentTime: 10,
      ranges: [[0, 30]],
    });
    updateBufferBar(container, audio);
    expect(container.childElementCount).toBe(1);
    const seg = container.children[0] as HTMLElement;
    // The segment spans the WHOLE range [0,30] (no left clip at the playhead):
    // the blue fill drawn above it covers [0,10]. Clipping at the playhead
    // instead would put a second round cap flush against the fill's round cap —
    // the two semicircles touch only at a point and open a lens-shaped gap
    // (rail showing through) above and below the seam.
    expect(seg.style.left).toBe("0%");
    expect(seg.style.width).toBe("3%");
  });

  it("BUG regression: segment carries a NEGATIVE head — flat left edge (rounded-r-sm), no convex left cap to butt against the fill cap at the playhead", () => {
    const container = document.createElement("div");
    const audio = makeAudio({
      duration: DUR,
      currentTime: 10,
      ranges: [[0, 30]],
    });
    updateBufferBar(container, audio);
    const seg = container.children[0] as HTMLElement;
    // Only the fill may carry a convex cap at the playhead seam. A rounded
    // left cap on the segment would form a second semicircle opposite the
    // fill's — the two touch at a single point and leave a lens-shaped gap of
    // bare rail above/below the seam. The rail's own overflow-hidden rounded
    // clip rounds the segment's flat left edge when the range starts at 0.
    expect(seg.className).toContain("rounded-r-sm");
    expect(seg.className).not.toContain("rounded-l-full");
    expect(seg.className).not.toContain("rounded-full");
  });

  it("BUG regression: the 2% negative-head pad does NOT move a range that already starts before playhead - 2% (start=0 stays at 0)", () => {
    const container = document.createElement("div");
    const audio = makeAudio({
      duration: 100,
      currentTime: 50,
      ranges: [[0, 100]],
    });
    updateBufferBar(container, audio, 50);
    // padStart = playhead - 2% = 48; min(start=0, 48) = 0 — the segment keeps
    // spanning the whole rail; only ranges starting at/near the playhead get
    // pulled back under the fill cap.
    expect(container.childElementCount).toBe(1);
    const seg = container.children[0] as HTMLElement;
    expect(seg.style.left).toBe("0%");
    expect(seg.style.width).toBe("100%");
  });

  it("BUG regression: playheadSeconds overrides the raw clock for playhead math (range starting at the playhead renders fully)", () => {
    const container = document.createElement("div");
    const audio = makeAudio({
      duration: 100,
      currentTime: 60, // raw clock ~200ms ahead of the throttled fill while playing
      ranges: [[50, 100]],
    });
    updateBufferBar(container, audio, 50);
    // The range starts exactly at the UI playhead (50), so it renders. The
    // override keeps the drop filters consistent with the position the blue
    // fill is showing — a segment starting at 50 must NOT be judged "ahead of
    // the playhead" (start > currentTime) and dropped.
    // The segment head is NEGATIVE: it starts 2% (BUFFER_HEAD_PAD_PCT) BEFORE
    // the playhead so its flat left edge tucks under the fill's round right
    // cap — the seam shows a single convex cap (the fill's) instead of two
    // opposing semicircles leaving a lens gap of bare rail at the playhead.
    expect(container.childElementCount).toBe(1);
    const seg = container.children[0] as HTMLElement;
    expect(seg.style.left).toBe("48%");
    expect(seg.style.width).toBe("52%");
  });

  it("BUG regression: backward seek keeps the full range — the fill (drawn above) covers the already-played part", () => {
    const container = document.createElement("div");
    const audio = makeAudio({
      duration: 900,
      currentTime: 420,
      ranges: [[0, 900]],
    });
    updateBufferBar(container, audio);
    // The browser still reports the full [0,900] after a backward seek. The
    // segment spans the whole range; the blue fill drawn on top covers [0,420],
    // so only [420,900] is visible — the bar cannot look "stuck" because the
    // segment exists UNDER the fill, not because it is left-clipped.
    expect(container.childElementCount).toBe(1);
    const seg = container.children[0] as HTMLElement;
    expect(seg.style.left).toBe("0%");
    expect(seg.style.width).toBe("100%");
  });

  it("BUG regression: fully-past ranges are dropped, crossing ranges render from their range start", () => {
    const container = document.createElement("div");
    const audio = makeAudio({
      duration: DUR,
      currentTime: 60,
      ranges: [
        [0, 30],
        [50, 200],
      ],
    });
    updateBufferBar(container, audio);
    // [0,30] ends before currentTime -> dropped; [50,200] straddles the
    // playhead -> rendered. Its head is pulled back to playhead - 2% (40s =
    // 4%) so the flat left edge hides under the fill's round cap; the fill
    // drawn above covers [0,60], so no lens gap opens at the seam.
    expect(container.childElementCount).toBe(1);
    const seg = container.children[0] as HTMLElement;
    expect(seg.style.left).toBe(`${String((40 / DUR) * 100)}%`);
    expect(seg.style.width).toBe(`${String(((200 - 40) / DUR) * 100)}%`);
  });

  it("BUG regression: no visible segments remain when every buffered range is in the past", () => {
    const container = document.createElement("div");
    const audio = makeAudio({
      duration: DUR,
      currentTime: 500,
      ranges: [
        [0, 100],
        [200, 300],
      ],
    });
    updateBufferBar(container, audio);
    expect(container.childElementCount).toBe(0);
  });

  it("forward seek with non-contiguous ranges renders the new segment from its range start", () => {
    const container = document.createElement("div");
    const audio = makeAudio({
      duration: DUR,
      currentTime: 505,
      ranges: [
        [0, 30],
        [500, 510],
      ],
    });
    updateBufferBar(container, audio);
    // The pre-seek [0,30] region is fully in the past now; [500,510] spans the
    // playhead -> rendered. Its head is pulled back to playhead - 2% (485s =
    // 48.5%) so the flat left edge hides under the fill's round cap; the fill
    // covers [0,505] above it, so only [505,510] is visible.
    expect(container.childElementCount).toBe(1);
    const seg = container.children[0] as HTMLElement;
    expect(seg.style.left).toBe(`${String((485 / DUR) * 100)}%`);
    expect(seg.style.width).toBe(`${String(((510 - 485) / DUR) * 100)}%`);
  });

  it("shrinking visible segment count removes extra segments", () => {
    const container = document.createElement("div");
    const two = makeAudio({
      duration: DUR,
      currentTime: 5,
      ranges: [
        [0, 30],
        [4, 200],
      ],
    });
    updateBufferBar(container, two);
    expect(container.childElementCount).toBe(2);
    const one = makeAudio({
      duration: DUR,
      currentTime: 60,
      ranges: [
        [0, 30],
        [50, 200],
      ],
    });
    updateBufferBar(container, one);
    expect(container.childElementCount).toBe(1);
  });

  it("empty buffered data clears the container", () => {
    const container = document.createElement("div");
    const two = makeAudio({
      duration: DUR,
      currentTime: 5,
      ranges: [
        [0, 30],
        [4, 200],
      ],
    });
    updateBufferBar(container, two);
    expect(container.childElementCount).toBe(2);
    const empty = makeAudio({ duration: DUR, currentTime: 0, ranges: [] });
    updateBufferBar(container, empty);
    expect(container.childElementCount).toBe(0);
  });

  it("invalid duration clears the container", () => {
    const container = document.createElement("div");
    const two = makeAudio({
      duration: DUR,
      currentTime: 5,
      ranges: [
        [0, 30],
        [4, 200],
      ],
    });
    updateBufferBar(container, two);
    const bad = makeAudio({
      duration: NaN,
      currentTime: 10,
      ranges: [[0, 30]],
    });
    updateBufferBar(container, bad);
    expect(container.childElementCount).toBe(0);
  });

  it("null container is a no-op", () => {
    const audio = makeAudio({
      duration: DUR,
      currentTime: 10,
      ranges: [[0, 30]],
    });
    expect(() => {
      updateBufferBar(null, audio);
    }).not.toThrow();
  });

  it("BUG regression (round 2): stale pre-seek range fully ahead of the playhead is dropped", () => {
    const container = document.createElement("div");
    const audio = makeAudio({
      duration: 900,
      currentTime: 420,
      ranges: [[720, 750]],
    });
    updateBufferBar(container, audio);
    // [12:00,12:30] was buffered before seeking back to 7:00; it sits entirely
    // ahead of the playhead, so rendering it would show a phantom segment at
    // the old position instead of the buffer at the new one.
    expect(container.childElementCount).toBe(0);
  });

  it("BUG regression (round 4): segment spans the full range — no left clip at the playhead (lens gap)", () => {
    const container = document.createElement("div");
    const audio = makeAudio({
      duration: 100,
      currentTime: 60, // raw clock ~200ms ahead of the throttled fill while playing
      ranges: [[10, 100]],
    });
    updateBufferBar(container, audio, 50);
    // Range [10,100] must render from its OWN start (10%), NOT clipped at the
    // UI playhead (50%). A clip at 50 would put the segment's round head flush
    // against the fill's round cap — two semicircles touching at a single
    // point, opening a lens-shaped gap (rail showing through) above/below the
    // seam. The fill drawn on top covers [0,50], hiding the [10,50] part.
    expect(container.childElementCount).toBe(1);
    const seg = container.children[0] as HTMLElement;
    expect(seg.style.left).toBe("10%");
    expect(seg.style.width).toBe("90%");
  });

  it("BUG regression (round 2): range starting exactly at the playhead renders one segment", () => {
    const container = document.createElement("div");
    const audio = makeAudio({
      duration: 900,
      currentTime: 420,
      ranges: [[420, 450]],
    });
    updateBufferBar(container, audio);
    // The segment head is pulled back to playhead - 2% (402s = 44.67%) so the
    // flat left edge hides under the fill's round cap at the playhead.
    expect(container.childElementCount).toBe(1);
    const seg = container.children[0] as HTMLElement;
    expect(seg.style.left).toBe(`${String((402 / 900) * 100)}%`);
    expect(seg.style.width).toBe(`${String(((450 - 402) / 900) * 100)}%`);
  });

  it("BUG regression (round 2): contiguous range spanning the playhead renders the full range (fill covers the played part)", () => {
    const container = document.createElement("div");
    const audio = makeAudio({
      duration: 900,
      currentTime: 420,
      ranges: [[0, 900]],
    });
    updateBufferBar(container, audio);
    expect(container.childElementCount).toBe(1);
    const seg = container.children[0] as HTMLElement;
    // Full [0,900] spans the playhead — no left clip; the fill covers [0,420].
    expect(seg.style.left).toBe("0%");
    expect(seg.style.width).toBe("100%");
  });
});
