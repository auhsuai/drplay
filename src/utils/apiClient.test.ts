import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { fetchWithAuth, getValidToken, TokenRefreshError } from './apiClient';
import { stopProactiveRefresh } from './apiClient';
import { setAccessToken } from './tokenStore';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  // tokenStore's access token is an in-memory module singleton -- reset it
  // between tests so state doesn't leak across `it()` blocks.
  setAccessToken(null);
  // Default: no stored refresh token, and the write-side keychain commands
  // are no-ops. Tests that exercise the refresh flow override this with a
  // full mockImplementation of their own.
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === 'get_token') return null;
    if (cmd === 'store_token' || cmd === 'clear_token' || cmd === 'update_stream_token') return undefined;
    throw new Error(`[test] unexpected invoke("${cmd}") with no override configured`);
  });
  (globalThis as unknown as { window: { dispatchEvent: (e: Event) => void } }).window = {
    dispatchEvent: vi.fn(),
  };
});

afterEach(() => {
  stopProactiveRefresh();
  setAccessToken(null);
  invokeMock.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetchWithAuth', () => {
  it('attaches the Bearer token to the outgoing request', async () => {
    setAccessToken('tok-123');
    const fetchSpy = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await fetchWithAuth('/api/songs');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const opts = fetchSpy.mock.calls[0][1] as RequestInit;
    const h = new Headers(opts.headers);
    expect(h.get('Authorization')).toBe('Bearer tok-123');
  });

  it('refreshes the token and retries once on 401', async () => {
    setAccessToken('old');
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_token') return 'rt';
      if (cmd === 'refresh_google_token') return { access_token: 'new', expires_in: 3600 };
      if (cmd === 'store_token' || cmd === 'update_stream_token') return undefined;
      throw new Error(`[test] unexpected invoke("${cmd}")`);
    });

    const queue = [new Response('', { status: 401 }), new Response('data', { status: 200 })];
    const fetchSpy = vi.fn().mockImplementation(async () => queue.shift()!);
    vi.stubGlobal('fetch', fetchSpy);
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');

    const res = await fetchWithAuth('/api/songs');

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(timeoutSpy).toHaveBeenCalledTimes(2); // fresh timeout for main request and retry
    const firstOpts = fetchSpy.mock.calls[0][1] as RequestInit;
    const retryOpts = fetchSpy.mock.calls[1][1] as RequestInit;
    expect(retryOpts.signal).not.toBe(firstOpts.signal);
    const retryHeaders = new Headers(retryOpts.headers);
    expect(retryHeaders.get('Authorization')).toBe('Bearer new');
  });

  it('returns the 401 response (no hang) when refresh fails', async () => {
    setAccessToken('old');
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_token') return 'rt';
      if (cmd === 'refresh_google_token') throw new Error('invalid_grant: revoked');
      throw new Error(`[test] unexpected invoke("${cmd}")`);
    });

    const fetchSpy = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    vi.stubGlobal('fetch', fetchSpy);

    const res = await fetchWithAuth('/api/songs');

    expect(res.status).toBe(401);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // no retry attempted
    expect(invokeMock).not.toHaveBeenCalledWith('update_stream_token', expect.anything());
  });

  it('applies AbortSignal.timeout to the request', async () => {
    setAccessToken('tok');
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchSpy = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await fetchWithAuth('/api/songs');

    expect(timeoutSpy).toHaveBeenCalled();
    expect(timeoutSpy).toHaveBeenCalledWith(15_000);
    const opts = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(opts.signal).toBeDefined();
  });

  it('throws a typed TokenRefreshError (not a raw error) when the 401 retry fails', async () => {
    setAccessToken('old');
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_token') return 'rt';
      if (cmd === 'refresh_google_token') return { access_token: 'new', expires_in: 3600 };
      if (cmd === 'store_token' || cmd === 'update_stream_token') return undefined;
      throw new Error(`[test] unexpected invoke("${cmd}")`);
    });

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
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_token') return 'rt';
      if (cmd === 'refresh_google_token') return { access_token: 'abc', expires_in: 3600 };
      if (cmd === 'store_token' || cmd === 'update_stream_token') return undefined;
      throw new Error(`[test] unexpected invoke("${cmd}")`);
    });
    const ok = await getValidToken(true);
    expect(typeof ok).toBe('string');
    expect(await getValidToken()).toBe('abc');

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_token') return 'rt';
      if (cmd === 'refresh_google_token') throw new Error('invalid_grant');
      throw new Error(`[test] unexpected invoke("${cmd}")`);
    });
    const fail = await getValidToken(true);
    expect(fail).toBeNull();
  });
});
