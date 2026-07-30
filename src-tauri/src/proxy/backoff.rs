use std::time::Duration;

use rand::Rng;

use super::constants::{COOLDOWN_BASE_SECS, COOLDOWN_EXP_CAP, COOLDOWN_MAX_SECS};

/// Exponential backoff (seconds) for the global rate-limit cooldown, hard-capped.
/// `fail_count` is the post-increment value of `FAIL_COUNT`.
pub fn compute_cooldown_secs(fail_count: u32) -> u64 {
    COOLDOWN_BASE_SECS
        .checked_shl(fail_count.min(COOLDOWN_EXP_CAP) as u32)
        .unwrap_or(COOLDOWN_MAX_SECS)
        .min(COOLDOWN_MAX_SECS)
}

/// AWS "Full Jitter": sleep a RANDOM duration in `[0, computed_delay]` instead
/// of `computed_delay` itself. Plain exponential backoff alone still lets
/// every concurrent retrier (the main fetch task plus up to
/// `PREFETCH_SEMAPHORE`'s 4 background workers, all hitting the same
/// transient Drive error at roughly the same time) wake up at the exact same
/// instants — 1s, 2s, 4s later — which just re-synchronizes into another
/// burst against Drive instead of spreading load out. Full Jitter is the
/// simplest of the three jittered strategies AWS compared and performed
/// within noise of the best ("Decorrelated Jitter") in their load tests.
/// Source: "Exponential Backoff And Jitter", AWS Architecture Blog (Marc
/// Brooker, 2015) — https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
pub fn full_jitter(computed_delay: Duration) -> Duration {
    let upper_ms = computed_delay.as_millis().max(1) as u64;
    let jittered_ms = rand::thread_rng().gen_range(0..=upper_ms);
    Duration::from_millis(jittered_ms)
}

/// AWS "Equal Jitter": keep HALF the computed delay fixed, randomize only the
/// other half (`sleep = delay/2 + random(0, delay/2)`). Used instead of
/// `full_jitter` specifically for the GLOBAL rate-limit cooldown below,
/// because `GLOBAL_BACKOFF_UNTIL` is a circuit-breaker "quiet period" floor
/// checked by every concurrent stream request — unlike one request's own
/// short retry loop, jittering it all the way down to near-zero would defeat
/// the point of having a minimum cooldown after repeated failures at all.
/// Source: same AWS post cited on `full_jitter`.
pub fn equal_jitter(computed_delay: Duration) -> Duration {
    let total_ms = computed_delay.as_millis().max(1) as u64;
    let half_ms = total_ms / 2;
    let jitter_ms = rand::thread_rng().gen_range(0..=(total_ms - half_ms));
    Duration::from_millis(half_ms + jitter_ms)
}
