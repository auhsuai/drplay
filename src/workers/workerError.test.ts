import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  classifyWorkerError,
  logWorkerError,
  WorkerAbortError,
} from './workerError';

describe('classifyWorkerError', () => {
  it('classifies an AbortSignal.timeout rejection as timeout', () => {
    const err = new Error('boom');
    err.name = 'TimeoutError';
    expect(classifyWorkerError(err)).toBe('timeout');
  });

  it('classifies a user/worker abort as abort', () => {
    const err = new DOMException('aborted', 'AbortError');
    expect(classifyWorkerError(err)).toBe('abort');
  });

  it('classifies a malformed JSON body as parse', () => {
    expect(classifyWorkerError(new SyntaxError('Unexpected token'))).toBe('parse');
  });

  it('classifies a network failure (fetch TypeError) as network', () => {
    const err = new TypeError('Failed to fetch');
    expect(classifyWorkerError(err)).toBe('network');
  });

  it('treats an unrelated TypeError as unknown', () => {
    expect(classifyWorkerError(new TypeError('cannot read property of undefined'))).toBe('unknown');
  });

  it('treats non-Error throwables as unknown', () => {
    expect(classifyWorkerError('just a string')).toBe('unknown');
    expect(classifyWorkerError(null)).toBe('unknown');
    expect(classifyWorkerError(undefined)).toBe('unknown');
  });
});

describe('WorkerAbortError', () => {
  it('is an Error with a recognizable name and is instanceof Error', () => {
    const err = new WorkerAbortError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('WorkerAbortError');
  });
});

describe('logWorkerError', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes module, timestamp and classified kind in the line', () => {
    logWorkerError('proSync/files', { status: 500 }, new Error('server down'), 'error');
    expect(console.error).toHaveBeenCalledTimes(1);
    const line = (console.error as any).mock.calls[0][0] as string;
    expect(line).toMatch(/\[proSync\/files\] unknown: server down/);
    expect(line).toMatch(/status=500/);
    // ISO timestamp prefix
    expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2}T/);
  });

  it('redacts auth tokens and file ids from the message', () => {
    const err = new Error('request failed with Bearer ya29.secret-token and ?id=1RoFd1kOvoIn');
    logWorkerError('scanner/list', {}, err, 'error');
    const line = (console.error as any).mock.calls[0][0] as string;
    expect(line).not.toContain('ya29.secret-token');
    expect(line).toContain('[REDACTED]');
    expect(line).toContain('id=[REDACTED_ID]');
  });

  it('does not leak a raw token passed via context', () => {
    logWorkerError('scanner/list', { token: 'ya29.leaky' }, new Error('oops'), 'warn');
    const line = (console.warn as any).mock.calls[0][0] as string;
    expect(line).not.toContain('ya29.leaky');
  });

  it('uses warn level for non-error severity', () => {
    logWorkerError('scanner/cache', { fileId: 'abc' }, new Error('miss'), 'warn');
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
  });
});
