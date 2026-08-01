import { describe, expect, it, vi } from 'vitest';
import { handleWorkerMessage } from './proSyncManager';
import type { ProSyncHandlerDeps } from './proSyncManager';

const EVENT = {
  progress: 'pro-sync-progress',
  complete: 'pro-sync-complete',
  busy: 'pro-sync-busy',
  noToken: 'pro-sync-no-token',
  error: 'pro-sync-error',
} as const;

function makeDeps(overrides: Partial<ProSyncHandlerDeps> = {}): {
  deps: ProSyncHandlerDeps;
  updateToken: ReturnType<typeof vi.fn>;
  dispatch: ReturnType<typeof vi.fn>;
  logError: ReturnType<typeof vi.fn>;
} {
  const updateToken = vi.fn();
  const dispatch = vi.fn();
  const logError = vi.fn();
  const deps: ProSyncHandlerDeps = {
    onTokenRefreshRequest: null,
    updateToken,
    dispatch,
    logError,
    ...overrides,
  };
  return { deps, updateToken, dispatch, logError };
}

describe('handleWorkerMessage', () => {
  it('TOKEN_EXPIRED with successful refresh calls updateToken and nothing else', async () => {
    const onTokenRefreshRequest = vi.fn().mockResolvedValue('new-token');
    const { deps, updateToken, dispatch, logError } = makeDeps({ onTokenRefreshRequest });

    await handleWorkerMessage({ type: 'TOKEN_EXPIRED' }, deps);

    expect(onTokenRefreshRequest).toHaveBeenCalledTimes(1);
    expect(updateToken).toHaveBeenCalledWith('new-token');
    expect(dispatch).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });

  it('TOKEN_EXPIRED with null refresh result does not call updateToken', async () => {
    const onTokenRefreshRequest = vi.fn().mockResolvedValue(null);
    const { deps, updateToken, dispatch, logError } = makeDeps({ onTokenRefreshRequest });

    await handleWorkerMessage({ type: 'TOKEN_EXPIRED' }, deps);

    expect(onTokenRefreshRequest).toHaveBeenCalledTimes(1);
    expect(updateToken).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });

  it('TOKEN_EXPIRED with no refresh handler does nothing', async () => {
    const { deps, updateToken, dispatch, logError } = makeDeps();

    await handleWorkerMessage({ type: 'TOKEN_EXPIRED' }, deps);

    expect(updateToken).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });

  it('TOKEN_EXPIRED with throwing refresh handler logs the error instead of propagating', async () => {
    const onTokenRefreshRequest = vi.fn().mockRejectedValue(new Error('refresh blew up'));
    const { deps, updateToken, dispatch, logError } = makeDeps({ onTokenRefreshRequest });

    await handleWorkerMessage({ type: 'TOKEN_EXPIRED' }, deps);

    expect(updateToken).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('refresh'));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('SYNC_PROGRESS dispatches progress event without logging', async () => {
    const { deps, dispatch, logError } = makeDeps();

    await handleWorkerMessage({ type: 'SYNC_PROGRESS' }, deps);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(EVENT.progress);
    expect(logError).not.toHaveBeenCalled();
  });

  it('SYNC_COMPLETE dispatches complete event without logging', async () => {
    const { deps, dispatch, logError } = makeDeps();

    await handleWorkerMessage({ type: 'SYNC_COMPLETE' }, deps);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(EVENT.complete);
    expect(logError).not.toHaveBeenCalled();
  });

  it('SYNC_BUSY dispatches busy event without logging (not an error)', async () => {
    const { deps, dispatch, logError } = makeDeps();

    await handleWorkerMessage({ type: 'SYNC_BUSY' }, deps);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(EVENT.busy);
    expect(logError).not.toHaveBeenCalled();
  });

  it('SYNC_NO_TOKEN logs the failure and dispatches no-token event', async () => {
    const { deps, dispatch, logError } = makeDeps();

    await handleWorkerMessage({ type: 'SYNC_NO_TOKEN' }, deps);

    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith('pro-sync: no token provided to worker');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(EVENT.noToken);
  });

  it('SYNC_ERROR logs the failure and dispatches error event', async () => {
    const { deps, dispatch, logError } = makeDeps();

    await handleWorkerMessage({ type: 'SYNC_ERROR' }, deps);

    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith('pro-sync: worker sync failed');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(EVENT.error);
  });

  it('unknown message type is ignored safely', async () => {
    const { deps, updateToken, dispatch, logError } = makeDeps();

    await handleWorkerMessage({ type: 'SOME_FUTURE_TYPE' }, deps);
    await handleWorkerMessage({}, deps);

    expect(updateToken).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });
});
