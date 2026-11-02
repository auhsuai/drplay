// ---- Per-file network cooldown (re-hang loop fix).
// Google Drive media endpoints have a known 30±5s first-byte delay under
// load (rclone forum threads 22681/8320). After ONE transient network/timeout
// failure for a fileId, every re-mount of the same card (scroll/filter
// re-render) used to re-spawn the range fetch and re-hang the UI for another
// ~30s before falling into the same placeholder. This map (fileId -> cooldown
// expiry) makes re-mounts inside the cooldown return the placeholder
// immediately WITHOUT touching the network.
//
// Scope rules (Phase A4 — deliberately narrow):
// - ONLY genuine transient failures (timeout / network / rate_limited) set a
//   cooldown. A `circuit_open` rejection is a GLOBAL state, not this file's
//   fault, and must never punish the file; an `aborted` result is a
//   cancellation, not a failure at all.
// - Deterministic failures (parse_error / unsupported / http_error) are
//   pinned in the metadata cache instead — a cooldown would only delay the
//   same deterministic result.
// - The cooldown is keyed by fileId only (the in-flight key is
//   fileId|size|name): a file that cannot be fetched is unfetchable for
//   every argument set, and pinning a second key would let one Drive stall
//   multiply into N cooldowns.
// - A SUCCESS clears the file's cooldown, so a card that recovered is
//   retryable immediately rather than for up to 60s.
// Entries are pruned lazily on read (fetchPipeline) and swept on every write,
// so the map cannot grow past the files that failed inside the current TTL.
export const networkCooldownUntil = new Map<string, number>();

/**
 * Pins (or refreshes) the cooldown for one fileId. Sweeps every already-expired
 * entry first: a file that failed once and is never re-read has no lazy prune
 * on read, so without this its entry would stay until the app-wide cache clear.
 */
export function setNetworkCooldown(fileId: string, until: number): void {
  const now = Date.now();
  for (const [key, expiry] of networkCooldownUntil) {
    if (expiry <= now) networkCooldownUntil.delete(key);
  }
  networkCooldownUntil.set(fileId, until);
}

/**
 * Drops the cooldown for ONE file after a successful fetch. Without this a
 * manual/refresh retry that succeeded still left every non-force caller
 * blocked for up to METADATA_NETWORK_COOLDOWN_MS.
 */
export function clearNetworkCooldownFor(fileId: string): void {
  networkCooldownUntil.delete(fileId);
}

/**
 * Drops every per-file network cooldown. Called by clearAllMetadataCache so a
 * user-initiated cache clear restores a fully CLEAN state — without this,
 * files that failed once stay placeholder-blocked for up to
 * METADATA_NETWORK_COOLDOWN_MS even after the explicit reset.
 */
export function clearNetworkCooldown(): void {
  networkCooldownUntil.clear();
}

/**
 * True when the file is still inside its cooldown (does NOT prune: pruning is
 * the caller's write-side job — see setNetworkCooldown).
 */
export function isNetworkCooldownActive(fileId: string, now: number): boolean {
  const until = networkCooldownUntil.get(fileId);
  return until !== undefined && until > now;
}
