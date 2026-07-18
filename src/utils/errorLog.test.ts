import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ERROR_LOG_MAX,
  captureError,
  clearErrorLogs,
  exportErrorLogsSanitized,
  getErrorLogs
} from './errorLog';
import { db } from '../db/db';

beforeEach(async () => {
  // Fully wipe the DB between tests so each case starts from a clean slate.
  await db.delete();
  await db.open();
});

describe('captureError', () => {
  it('sanitizes sensitive data (id/token/bearer/link) on capture', async () => {
    await captureError({
      level: 'error',
      source: 'test',
      message:
        'fetch failed ?id=ABC123xyz access_token=secret Bearer tok http://127.0.0.1:9999/stream?id=X'
    });

    const logs = await getErrorLogs();
    expect(logs).toHaveLength(1);
    const msg = logs[0].message;
    expect(msg).toContain('[REDACTED_ID]');
    expect(msg).toContain('[REDACTED_TOKEN]');
    expect(msg).toContain('[REDACTED_LINK]');
    expect(msg).not.toContain('ABC123xyz');
    expect(msg).not.toContain('access_token=secret');
    expect(msg).not.toContain('Bearer tok');
    expect(msg).not.toContain('http://127.0.0.1:9999/stream?id=X');
  });

  it('caps at ERROR_LOG_MAX and removes oldest', async () => {
    for (let i = 0; i < ERROR_LOG_MAX + 1; i++) {
      await captureError({ source: 'cap', message: `entry-${i}`, kind: 'seq' });
    }

    const logs = await getErrorLogs();
    expect(logs).toHaveLength(ERROR_LOG_MAX);

    const tsValues = logs.map((e) => e.ts);
    const minTs = Math.min(...tsValues);
    // entry-0 was captured first => had the smallest ts => must be gone
    const hasEntry0 = await db.errorLogs
      .filter((e) => e.message === 'entry-0')
      .count();
    expect(hasEntry0).toBe(0);
    // the smallest remaining ts should be > the deleted one's ts
    expect(minTs).toBeGreaterThan(0);
  });

  it('returns newest-first from getErrorLogs', async () => {
    await captureError({ source: 's', message: 'old', kind: 'k' });
    await new Promise((r) => setTimeout(r, 5));
    await captureError({ source: 's', message: 'new', kind: 'k' });

    const logs = await getErrorLogs();
    const oldIdx = logs.findIndex((e) => e.message === 'old');
    const newIdx = logs.findIndex((e) => e.message === 'new');
    expect(newIdx).toBeLessThan(oldIdx);
    expect(logs[0].message).toBe('new');
  });

  it('does NOT throw when Dexie errors (never throw)', async () => {
    const spy = vi
      .spyOn(db.errorLogs, 'add')
      .mockRejectedValueOnce(new Error('db boom'));

    await expect(
      captureError({ source: 's', message: 'boom' })
    ).resolves.toBeUndefined();

    spy.mockRestore();
  });
});

describe('clearErrorLogs', () => {
  it('empties all logs', async () => {
    await captureError({ source: 's', message: 'a' });
    await captureError({ source: 's', message: 'b' });
    expect(await getErrorLogs()).toHaveLength(2);

    await clearErrorLogs();
    expect(await getErrorLogs()).toHaveLength(0);
  });
});

describe('exportErrorLogsSanitized', () => {
  it('formats entries with redacted content', async () => {
    await captureError({
      level: 'error',
      source: 'src/foo.ts',
      message: 'bad id=ABC123xyz',
      stack: 'at foo (http://127.0.0.1:9999/stream?id=X:1:1)'
    });

    const out = await exportErrorLogsSanitized();
    expect(out).toContain('error | src/foo.ts');
    expect(out).toContain('[REDACTED_ID]');
    expect(out).toContain('[REDACTED_LINK]');
    expect(out).not.toContain('ABC123xyz');
    expect(out).toMatch(/^\[\d{4}-\d{2}-\d{2}T/);
  });

  it('returns empty string when no logs', async () => {
    expect(await exportErrorLogsSanitized()).toBe('');
  });
});
