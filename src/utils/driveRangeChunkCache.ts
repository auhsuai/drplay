// LRU store for the DriveRangeTokenizer's aligned 64KB chunks (refactor:
// extracted verbatim from driveRangeTokenizer.ts — same Map-based eviction,
// same refresh-on-hit semantics, same MAX_CACHED_CHUNKS bound).
export const MAX_CACHED_CHUNKS = 128; // LRU bound (~8MB at 64KB chunks)

export class AlignedChunkCache {
  private readonly chunks = new Map<number, Uint8Array>();

  get size(): number {
    return this.chunks.size;
  }

  /** Plain read without an LRU refresh (prefetchRange's existing-entry check). */
  peek(chunkStart: number): Uint8Array | undefined {
    return this.chunks.get(chunkStart);
  }

  /**
   * Cache-hit lookup. Map preserves insertion order, so delete+set on a hit
   * "moves to the end": the first key is now the least-recently-used one,
   * making the eviction a true LRU (hot chunks survive repeated seeking).
   */
  get(chunkStart: number): Uint8Array | undefined {
    const cached = this.chunks.get(chunkStart);
    if (cached === undefined) return undefined;
    this.chunks.delete(chunkStart);
    this.chunks.set(chunkStart, cached);
    return cached;
  }

  /**
   * Store a chunk. A subarray view keeps its parent ArrayBuffer alive, so
   * anything that does not own its buffer is copied — otherwise one 64KB
   * entry could pin the whole multi-MB region it was sliced from, blowing
   * the LRU's byte bound. Re-setting an existing key refreshes its recency
   * (delete+set, mirror of get) so the just-seeded entry is not the next
   * eviction victim.
   */
  set(chunkStart: number, data: Uint8Array): void {
    const owned =
      data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
        ? data
        : data.slice();
    this.chunks.delete(chunkStart);
    this.chunks.set(chunkStart, owned);
  }

  /** Drop entries from the least-recently-used end beyond the LRU bound. */
  evict(): void {
    while (this.chunks.size > MAX_CACHED_CHUNKS) {
      const oldest = this.chunks.keys().next().value;
      if (oldest === undefined) break;
      this.chunks.delete(oldest);
    }
  }
}
