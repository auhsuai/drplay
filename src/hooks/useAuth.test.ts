// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useAuth } from './useAuth';
import { invalidateCurrentSession } from '../utils/sessionGuard';
import { revokeGoogleToken, stopProactiveRefresh } from '../utils/apiClient';
import { clearAllMetadataCache } from '../utils/metadata';
import { captureError } from '../utils/errorLog';
import { stopProSyncWorker } from '../utils/proSyncManager';

const authState = vi.hoisted(() => ({
  isLoggedIn: false,
  accessToken: null as string | null,
  userProfile: null,
  setIsLoggedIn: vi.fn(),
  setAccessToken: vi.fn(),
  setUserProfile: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock('../store/authStore', () => ({
  useAuthStore: ((selector: (state: unknown) => unknown) => selector(authState)),
}));

vi.mock('../utils/proSyncManager', () => ({
  startProSyncWorker: vi.fn(),
  stopProSyncWorker: vi.fn(),
  setTokenRefreshHandler: vi.fn(),
  updateWorkerToken: vi.fn(),
}));

vi.mock('../utils/sessionGuard', () => ({
  invalidateCurrentSession: vi.fn(),
}));

vi.mock('../utils/apiClient', () => ({
  revokeGoogleToken: vi.fn(),
  stopProactiveRefresh: vi.fn(),
  fetchWithAuth: vi.fn(),
  getValidToken: vi.fn(),
  scheduleProactiveRefresh: vi.fn(),
}));

vi.mock('../utils/cache', () => ({
  CLEAR_LOCAL_CACHE_CMD: 'clear_local_cache',
  clearAppCache: vi.fn(),
}));

vi.mock('../utils/metadata', () => ({
  clearAllMetadataCache: vi.fn(),
}));

vi.mock('../utils/errorLog', () => ({
  captureError: vi.fn(),
}));

vi.mock('../utils/simpleToast', () => ({
  showErrorToast: vi.fn(),
}));

vi.mock('./usePlayer', () => ({
  PLAYER_STOP_EVENT: 'player-stop',
}));

const mockedInvoke = vi.mocked(invoke);
const mockedListen = vi.mocked(listen);
const mockedInvalidateCurrentSession = vi.mocked(invalidateCurrentSession);
const mockedRevokeGoogleToken = vi.mocked(revokeGoogleToken);
const mockedStopProactiveRefresh = vi.mocked(stopProactiveRefresh);
const mockedClearAllMetadataCache = vi.mocked(clearAllMetadataCache);
const mockedCaptureError = vi.mocked(captureError);
const mockedStopProSyncWorker = vi.mocked(stopProSyncWorker);

const LS_ACCESS_TOKEN = 'drplay_access_token';

const invokedCommands = (): string[] => mockedInvoke.mock.calls.map(call => call[0] as string);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockedInvoke.mockImplementation(async () => undefined);
  mockedListen.mockResolvedValue(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useAuth handleLogout backend cleanup', () => {
  it('does NOT invoke the removed clear_stream_token command (regression: command deleted in the SW migration)', async () => {
    const onLogoutExt = vi.fn();
    const { result } = renderHook(() => useAuth(onLogoutExt));

    await act(async () => {
      await result.current.handleLogout();
    });

    expect(invokedCommands()).not.toContain('clear_stream_token');
    expect(invokedCommands()).toContain('clear_local_cache');
    expect(mockedClearAllMetadataCache).toHaveBeenCalled();
    expect(mockedInvalidateCurrentSession).toHaveBeenCalled();
    expect(mockedStopProSyncWorker).toHaveBeenCalled();
    expect(mockedStopProactiveRefresh).toHaveBeenCalled();
    expect(onLogoutExt).toHaveBeenCalled();
    expect(
      mockedCaptureError.mock.calls.some(([c]) => c.message.includes('clear_stream_token'))
    ).toBe(false);
  });

  it('skips clear_stream_token also when a token is present and revoke runs (variant: token branch)', async () => {
    localStorage.setItem(LS_ACCESS_TOKEN, 'tok-123');
    const onLogoutExt = vi.fn();
    const { result } = renderHook(() => useAuth(onLogoutExt));

    await act(async () => {
      await result.current.handleLogout();
    });

    expect(invokedCommands()).not.toContain('clear_stream_token');
    expect(mockedRevokeGoogleToken).toHaveBeenCalledWith('tok-123');
    expect(onLogoutExt).toHaveBeenCalled();
  });

  it('logs a warn and continues logout when clear_local_cache fails (contract preserved)', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'clear_local_cache') throw new Error('backend down');
      return undefined;
    });
    const onLogoutExt = vi.fn();
    const { result } = renderHook(() => useAuth(onLogoutExt));

    await act(async () => {
      await result.current.handleLogout();
    });

    expect(onLogoutExt).toHaveBeenCalled();
    expect(
      mockedCaptureError.mock.calls.some(([c]) =>
        c.message.includes('Failed to clear backend cache')
      )
    ).toBe(true);
  });
});
