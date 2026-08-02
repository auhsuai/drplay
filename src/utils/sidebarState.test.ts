// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureError } from './errorLog';
import { LS_SIDEBAR_OPEN, loadSidebarOpenState, saveSidebarOpenState } from './sidebarState';

vi.mock('./errorLog', () => ({
  captureError: vi.fn().mockResolvedValue(undefined)
}));

const mockedCaptureError = vi.mocked(captureError);

// Sidebar open/closed persistence (consumed by App.tsx init + toggle). Pure
// helpers so the localStorage contract is testable without mounting the whole
// lazy-loaded app tree.
describe('sidebarState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('defaults to open (true) when no key is stored — first launch must show the expanded sidebar', () => {
    expect(loadSidebarOpenState()).toBe(true);
  });

  it("returns false when the stored value is exactly 'false'", () => {
    localStorage.setItem(LS_SIDEBAR_OPEN, 'false');
    expect(loadSidebarOpenState()).toBe(false);
  });

  it("returns true when the stored value is 'true'", () => {
    localStorage.setItem(LS_SIDEBAR_OPEN, 'true');
    expect(loadSidebarOpenState()).toBe(true);
  });

  it('falls back to open (true) for any unexpected stored value (corrupt/legacy)', () => {
    localStorage.setItem(LS_SIDEBAR_OPEN, 'garbage');
    expect(loadSidebarOpenState()).toBe(true);
    localStorage.setItem(LS_SIDEBAR_OPEN, '');
    expect(loadSidebarOpenState()).toBe(true);
  });

  it('persists the state under the LS_SIDEBAR_OPEN key as a plain boolean string', () => {
    saveSidebarOpenState(false);
    expect(localStorage.getItem(LS_SIDEBAR_OPEN)).toBe('false');
    saveSidebarOpenState(true);
    expect(localStorage.getItem(LS_SIDEBAR_OPEN)).toBe('true');
  });

  it('loadSidebarOpenState: SecurityError from localStorage.getItem is caught → returns true (default-open) and logs', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });

    expect(loadSidebarOpenState()).toBe(true);
    expect(mockedCaptureError).toHaveBeenCalledWith({
      level: 'warn',
      source: 'sidebarState',
      message: 'sidebar-open-read-failed:SecurityError'
    });
  });

  it('saveSidebarOpenState: SecurityError from setItem does not throw and logs', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });

    expect(() => saveSidebarOpenState(false)).not.toThrow();
    expect(mockedCaptureError).toHaveBeenCalledWith({
      level: 'warn',
      source: 'sidebarState',
      message: 'sidebar-open-write-failed:SecurityError'
    });
  });
});
