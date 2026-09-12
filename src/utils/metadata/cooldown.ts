// ---- Per-file network cooldown (re-hang loop fix).
// Google Drive media endpoints have a known 30±5s first-byte delay under
// load (rclone forum threads 22681/8320). After ONE network failure for a
// fileId, every re-mount of the same card (scroll/filter re-render) used to
// re-spawn the range fetch and re-hang the UI for another ~30s before
// falling into the same placeholder. This map (fileId -> cooldown expiry)
// makes re-mounts inside the cooldown return the placeholder immediately
// WITHOUT touching the network — no spam of a Drive that just failed, no
// repeated hang. Unlike the app-wide circuit breaker (fail-fast after a
// throttle threshold), this is per-file: one slow file does not block the
// rest. forceNetwork bypasses the cooldown (manual retry via RefreshCw).
// Entries are pruned lazily on read; only recently-failed files are ever in
// the map, so it stays tiny and needs no timer.
export const networkCooldownUntil = new Map<string, number>();

/**
 * Drops every per-file network cooldown. Called by clearAllMetadataCache so a
 * user-initiated cache clear restores a fully CLEAN state — without this,
 * files that failed once stay placeholder-blocked for up to
 * METADATA_NETWORK_COOLDOWN_MS even after the explicit reset.
 */
export function clearNetworkCooldown(): void {
  networkCooldownUntil.clear();
}
