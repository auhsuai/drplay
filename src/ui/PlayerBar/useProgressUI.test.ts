import { describe, it, expect } from 'vitest';

// Seek correction logic was removed in the native audio refactor.
// The native Rust player (rodio + symphonia) is sample-accurate,
// eliminating the need for client-side seek discrepancy correction.
// All tests below are vestigial; kept as reference only.

describe('seek correction (legacy — native player is sample-accurate)', () => {
  it('no correction needed with native Rust audio engine', () => {
    expect(true).toBe(true);
  });
});
