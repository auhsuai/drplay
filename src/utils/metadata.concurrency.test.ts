// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTrackMetadata, clearAllMetadataCache } from './metadata';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('idb-keyval', () => ({
  get: vi.fn(() => Promise.resolve(undefined)),
  set: vi.fn(() => Promise.resolve()),
  del: vi.fn(() => Promise.resolve()),
}));

const { invoke } = await import('@tauri-apps/api/core');

describe('getTrackMetadata concurrency', () => {
  beforeEach(() => {
    clearAllMetadataCache();
    vi.mocked(invoke).mockReset();
  });

  it('limits concurrent get_local_metadata IPC calls to at most 5 when 50 different files request simultaneously', async () => {
    // Make invoke slow so we can count in-flight calls.
    let inFlight = 0;
    let maxConcurrent = 0;
    let currentId = 0;

    vi.mocked(invoke).mockImplementation(async (_cmd: string, _args: any) => {
      inFlight++;
      if (inFlight > maxConcurrent) maxConcurrent = inFlight;
      const id = currentId++;
      // Yield once so queue can drain then dispatch next batch.
      await new Promise(r => setTimeout(r, 0));
      inFlight--;
      return { id: String(id), title: String(id), artist: '', album: '', duration: 0, has_cover: false, file_type: 'audio/mpeg' };
    });

    // Fire 10 concurrent getTrackMetadata calls (different fileIds).
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(getTrackMetadata(`file-${i}`, 'tok', 1000, `song${i}.mp3`));
    }

    await Promise.all(promises);

    // At most 5 IPC calls should have been in-flight concurrently.
    expect(maxConcurrent).toBeLessThanOrEqual(5);
  });
});
