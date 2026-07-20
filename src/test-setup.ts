// Vitest setup shared across all test environments (node + jsdom).
// Required so @testing-library/react's act() works correctly under React 19:
// without IS_REACT_ACT_ENVIRONMENT, effect-driven async state updates keep the
// React scheduler (MessageChannel) alive and vitest never exits after hook tests.
if (typeof globalThis !== 'undefined') {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
}

// Polyfill IntersectionObserver for jsdom — SongCard uses it to defer metadata
// fetching until the card is near viewport. Without this every SongCard mount
// would fire getTrackMetadata simultaneously (50 IPC burst on page change).
if (typeof IntersectionObserver === 'undefined' && typeof globalThis !== 'undefined') {
  class MockIntersectionObserver {
    private callback: IntersectionObserverCallback;
    readonly root: Element | Document | null = null;
    readonly rootMargin: string = '';
    readonly thresholds: ReadonlyArray<number> = [];
    constructor(callback: IntersectionObserverCallback) {
      this.callback = callback;
    }
    observe(target: Element) {
      this.callback([{ target, isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry], this);
    }
    disconnect() {}
    unobserve() {}
    takeRecords() { return []; }
  }
  (globalThis as Record<string, unknown>).IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;
}
