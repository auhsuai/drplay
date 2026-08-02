import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { fetchWithAuth, getValidToken, TokenRefreshError } from './apiClient';
import { stopProactiveRefresh } from './apiClient';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

function makeStorage(): Storage {
  let s: Record<string, string> = {};
  return {
    getItem: (k: string) => (k in s ? s[k] : null),
    setItem: (k: string, v: string) => { s[k] = String(v); },
    removeItem: (k: string) => { delete s[k]; },
    clear: () => { s = {}; },
    key: () => null,
    get length() { return Object.keys(s).length; },
  } as Storage;
}

let storage: Storage;

beforeEach(() => {
  storage = makeStorage();
  (globalThis as unknown as { localStorage: Storage }).localStorage = storage;
  (globalThis as unknown as { window: { dispatchEvent: (e: Event) => void } }).window = {
    dispatchEvent: vi.fn(),
  };
});

afterEach(() => {
  stopProactiveRefresh();
  invokeMock.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetchWithAuth', () => {
  it('attaches the Bearer token to the outgoing request', async () => {
    storage.setItem('drplay_access_token', 'tok-123');
    const fetchSpy = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await fetchWithAuth('/api/songs');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const opts = fetchSpy.mock.calls[0][1] as RequestInit;
    const h = new Headers(opts.headers);
    expect(h.get('Authorization')).toBe('Bearer tok-123');
  });

  it('refreshes the token and retries once on 401', async () => {
    storage.setItem('drplay_access_token', 'old');
    storage.setItem('drplay_refresh_token', 'rt');
    invokeMock.mockResolvedValue({ access_token: 'new', expires_in: 3600 });

    const queue = [new Response('', { status: 401 }), new Response('data', { status: 200 })];
    const fetchSpy = vi.fn().mockImplementation(async () => queue.shift()!);
    vi.stubGlobal('fetch', fetchSpy);
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');

    const res = await fetchWithAuth('/api/songs');

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(timeoutSpy).toHaveBeenCalled(); // timeout applied on main + reused on retry
    const retryOpts = fetchSpy.mock.calls[1][1] as RequestInit;
    const retryHeaders = new Headers(retryOpts.headers);
    expect(retryHeaders.get('Authorization')).toBe('Bearer new');
    expect(storage.getItem('drplay_access_token')).toBe('new');
  });

  it('returns the 401 response (no hang) when refresh fails', async () => {
    storage.setItem('drplay_access_token', 'old');
    storage.setItem('drplay_refresh_token', 'rt');
    invokeMock.mockRejectedValue(new Error('invalid_grant: revoked'));

    const fetchSpy = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    vi.stubGlobal('fetch', fetchSpy);

    const res = await fetchWithAuth('/api/songs');

    expect(res.status).toBe(401);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // no retry attempted
  });

  it('applies AbortSignal.timeout to the request', async () => {
    storage.setItem('drplay_access_token', 'tok');
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchSpy = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await fetchWithAuth('/api/songs');

    expect(timeoutSpy).toHaveBeenCalled();
    expect(timeoutSpy).toHaveBeenCalledWith(15_000);
    const opts = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(opts.signal).toBeDefined();
  });

  it('uses the caller-supplied timeoutMs override for AbortSignal.timeout', async () => {
    storage.setItem('drplay_access_token', 'tok');
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchSpy = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await fetchWithAuth('/api/songs', { timeoutMs: 30_000 });

    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
  });

  it.each([
    ['0', 0],
    ['negative', -5],
    ['NaN', NaN],
  ])('falls back to the default 15s timeout when timeoutMs is %s', async (_label: string, bad: number) => {
    storage.setItem('drplay_access_token', 'tok');
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchSpy = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await fetchWithAuth('/api/songs', { timeoutMs: bad });

    expect(timeoutSpy).toHaveBeenCalledWith(15_000);
  });

  it('keeps the timeout override on the 401 retry (same merged signal)', async () => {
    storage.setItem('drplay_access_token', 'old');
    storage.setItem('drplay_refresh_token', 'rt');
    invokeMock.mockResolvedValue({ access_token: 'new', expires_in: 3600 });

    const queue = [new Response('', { status: 401 }), new Response('data', { status: 200 })];
    const fetchSpy = vi.fn().mockImplementation(async () => queue.shift()!);
    vi.stubGlobal('fetch', fetchSpy);
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');

    const res = await fetchWithAuth('/api/songs', { timeoutMs: 60_000 });

    expect(res.status).toBe(200);
    expect(timeoutSpy).toHaveBeenCalledWith(60_000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const firstSignal = (fetchSpy.mock.calls[0][1] as RequestInit).signal;
    const retrySignal = (fetchSpy.mock.calls[1][1] as RequestInit).signal;
    expect(retrySignal).toBe(firstSignal);
  });

  it('merges the caller signal with the timeout override via AbortSignal.any', async () => {
    storage.setItem('drplay_access_token', 'tok');
    const controller = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const anySpy = vi.spyOn(AbortSignal, 'any');
    const fetchSpy = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await fetchWithAuth('/api/songs', { timeoutMs: 45_000, signal: controller.signal });

    expect(timeoutSpy).toHaveBeenCalledWith(45_000);
    expect(anySpy).toHaveBeenCalledWith([controller.signal, timeoutSpy.mock.results[0].value]);
    const opts = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(opts.signal).toBe(anySpy.mock.results[0].value);
  });

  it('throws a typed TokenRefreshError (not a raw error) when the 401 retry fails', async () => {
    storage.setItem('drplay_access_token', 'old');
    storage.setItem('drplay_refresh_token', 'rt');
    invokeMock.mockResolvedValue({ access_token: 'new', expires_in: 3600 });

    const queue = [new Response('', { status: 401 }), null];
    const fetchSpy = vi.fn().mockImplementation(async () => {
      const next = queue.shift();
      if (next === null) throw new Error('network down');
      return next;
    });
    vi.stubGlobal('fetch', fetchSpy);

    await expect(fetchWithAuth('/api/songs')).rejects.toBeInstanceOf(TokenRefreshError);
  });

  it('getValidToken stays falsy-safe (returns string on success, null on failure)', async () => {
    storage.setItem('drplay_refresh_token', 'rt');
    invokeMock.mockResolvedValue({ access_token: 'abc', expires_in: 3600 });
    const ok = await getValidToken(true);
    expect(typeof ok).toBe('string');
    expect(await getValidToken()).toBe('abc');

    invokeMock.mockRejectedValue(new Error('invalid_grant'));
    const fail = await getValidToken(true);
    expect(fail).toBeNull();
  });
});
