import { db } from './db';

export async function get<T = unknown>(key: string): Promise<T | undefined> {
  try {
    const row = await db.kv.get(key);
    return row?.value as T | undefined;
  } catch (e: unknown) {
    if (e instanceof DOMException) {
      console.warn('[kv] get DOMException', { key, name: e.name, message: e.message });
    } else {
      console.warn('[kv] get error', { key, error: e });
    }
    throw e;
  }
}

export async function set(key: string, value: unknown): Promise<void> {
  try {
    await db.kv.put({ key, value });
  } catch (e: unknown) {
    if (e instanceof DOMException) {
      console.warn('[kv] set DOMException', { key, name: e.name, message: e.message });
    } else {
      console.warn('[kv] set error', { key, error: e });
    }
    throw e;
  }
}

export async function del(key: string): Promise<void> {
  try {
    await db.kv.delete(key);
  } catch (e: unknown) {
    if (e instanceof DOMException) {
      console.warn('[kv] del DOMException', { key, name: e.name, message: e.message });
    } else {
      console.warn('[kv] del error', { key, error: e });
    }
    throw e;
  }
}
