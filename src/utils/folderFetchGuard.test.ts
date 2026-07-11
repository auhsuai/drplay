import { describe, it, expect } from 'vitest';
import { createFolderFetchGuard } from './folderFetchGuard';

describe('createFolderFetchGuard', () => {
  it('only the latest started request is reported as latest', () => {
    const g = createFolderFetchGuard();
    const a = g.start();
    const b = g.start();
    expect(g.isLatest(a)).toBe(false);
    expect(g.isLatest(b)).toBe(true);
  });

  it('returns strictly increasing ids', () => {
    const g = createFolderFetchGuard();
    expect(g.start()).toBeLessThan(g.start());
  });

  it('a superseded request stops being latest after a newer one starts', () => {
    const g = createFolderFetchGuard();
    const a = g.start();
    g.start();
    expect(g.isLatest(a)).toBe(false);
  });
});
