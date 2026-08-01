import { db } from './db';

async function runOp<T>(op: string, key: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e: unknown) {
    console.warn(`[kv] ${op} error`, { key, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
    throw e;
  }
}

export async function get<T = unknown>(key: string): Promise<T | undefined> {
  return runOp('get', key, async () => {
    const row = await db.kv.get(key);
    return row?.value as T | undefined;
  });
}

export async function set(key: string, value: unknown): Promise<void> {
  return runOp('set', key, async () => {
    await db.kv.put({ key, value });
  });
}

export async function del(key: string): Promise<void> {
  return runOp('del', key, async () => {
    await db.kv.delete(key);
  });
}
