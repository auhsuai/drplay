import { db } from './db';

export async function get<T = any>(key: string): Promise<T | undefined> {
  const row = await db.kv.get(key);
  return row?.value as T | undefined;
}

export async function set(key: string, value: any): Promise<void> {
  await db.kv.put({ key, value });
}

export async function del(key: string): Promise<void> {
  await db.kv.delete(key);
}
