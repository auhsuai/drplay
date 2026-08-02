import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('sessionGuard', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('initializes getCurrentSessionId to 0', async () => {
    const { getCurrentSessionId } = await import('./sessionGuard');
    expect(getCurrentSessionId()).toBe(0);
  });

  it('increments the session id by 1 on invalidateCurrentSession', async () => {
    const mod = await import('./sessionGuard');
    mod.invalidateCurrentSession();
    expect(mod.getCurrentSessionId()).toBe(1);
  });

  it('reaches +2 after two invalidateCurrentSession calls', async () => {
    const mod = await import('./sessionGuard');
    mod.invalidateCurrentSession();
    mod.invalidateCurrentSession();
    expect(mod.getCurrentSessionId()).toBe(2);
  });
});
