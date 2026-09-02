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

  set(chunkStart: number, data: Uint8Array): void {
    this.chunks.set(chunkStart, data);
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
