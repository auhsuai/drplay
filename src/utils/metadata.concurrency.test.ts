// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTrackMetadata, clearAllMetadataCache } from './metadata';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

// Retarget persistence to an in-memory fake of db.metadataCache.
// The real db import is replaced so no IndexedDB/fake-indexeddb is needed.
const memoryStore = new Map<string, any>();
vi.mock('../db/db', () => ({
  db: {
    metadataCache: {
      get: (key: string) => Promise.resolve(memoryStore.get(key)),
      put: (row: any) => { memoryStore.set(row.key, row); return Promise.resolve(); },
      delete: (key: string) => { memoryStore.delete(key); return Promise.resolve(); },
    },
  },
}));

const { invoke } = await import('@tauri-apps/api/core');

class ConcurrencyQueue {
  private queue: (() => void)[] = [];
  private activeCount = 0;
  constructor(private concurrency: number) {}
  async enqueue<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return new Promise((resolve, reject) => {
      const run = async () => {
        if (signal?.aborted) {
          this.activeCount--;
          this.dequeue();
          return reject(new DOMException("Aborted", "AbortError"));
        }
        try {
          resolve(await task());
        } catch (e) {
          reject(e);
        } finally {
          this.activeCount--;
          this.dequeue();
        }
      };
      if (this.activeCount < this.concurrency) {
        this.activeCount++;
        run();
      } else {
        this.queue.push(run);
      }
    });
  }
  private dequeue() {
    if (this.queue.length > 0 && this.activeCount < this.concurrency) {
      const next = this.queue.shift();
      if (next) {
        this.activeCount++;
        next();
      }
    }
  }
}

describe('ConcurrencyQueue deadlock', () => {
  it('blocks all subsequent tasks when all slots are occupied by hanging tasks', async () => {
    const queue = new ConcurrencyQueue(2);

    const hangingTask = () => new Promise<string>(() => {});

    const fastTask = () => Promise.resolve('done');

    void queue.enqueue(hangingTask);

    let secondResolved = false;
    void queue.enqueue(hangingTask).then(() => { secondResolved = true; });

    let thirdResolved = false;
    void queue.enqueue(fastTask).then(() => { thirdResolved = true; });

    await new Promise(r => setTimeout(r, 100));
    expect(secondResolved).toBe(false);
    expect(thirdResolved).toBe(false);
  });

  it('direct calls (no queue) process independently even when some tasks hang', async () => {
    const hangingTask = () => new Promise<string>(() => {});

    const fastTask = () => Promise.resolve('done');

    void hangingTask();
    void hangingTask();

    const fastResult = await fastTask();
    expect(fastResult).toBe('done');
  });
});

describe('getTrackMetadata caching', () => {
  beforeEach(() => {
    clearAllMetadataCache();
    vi.mocked(invoke).mockReset();
  });

  it('returns cached metadata on second call without invoking IPC', async () => {
    vi.mocked(invoke).mockResolvedValue({
      id: '123',
      title: 'Real Title',
      artist: 'Real Artist',
      album: '',
      duration: 200,
      has_cover: true,
      file_type: 'audio/mpeg',
    });

    // First call: goes to IPC.
    const r1 = await getTrackMetadata('file-1', 'tok', 1000, 'song.mp3');
    expect(r1.title).toBe('Real Title');
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);

    // Second call same fileId: should return from memory cache, NO IPC.
    vi.mocked(invoke).mockClear();
    const r2 = await getTrackMetadata('file-1', 'tok', 1000, 'song.mp3');
    expect(r2.title).toBe('Real Title');
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
  });
});
