// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadMinimizeToTrayState } from './App';

// Lazy-useState initializer for the minimize-to-tray preference. Extracted
// from the inline initializer so the localStorage contract (default on first
// launch, strict 'true' match, tolerate blocked storage) is testable without
// mounting the whole lazy-loaded app tree.
describe('loadMinimizeToTrayState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('defaults to true when the key is missing (first launch — tray minimized)', () => {
    expect(loadMinimizeToTrayState()).toBe(true);
  });

  it("returns true when the stored value is exactly 'true'", () => {
    localStorage.setItem('drplay_minimize_to_tray', 'true');
    expect(loadMinimizeToTrayState()).toBe(true);
  });

  it("returns false for any other stored value ('false' / corrupt)", () => {
    localStorage.setItem('drplay_minimize_to_tray', 'false');
    expect(loadMinimizeToTrayState()).toBe(false);
    localStorage.setItem('drplay_minimize_to_tray', 'garbage');
    expect(loadMinimizeToTrayState()).toBe(false);
  });

  it('falls back to true when localStorage.getItem throws (SecurityError)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });

    expect(loadMinimizeToTrayState()).toBe(true);
  });
});
