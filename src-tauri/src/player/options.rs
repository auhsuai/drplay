//! Engine option set for the in-process libmpv engine, ported from the
//! sidecar flag list (mpv/process.rs:106-198).
//!
//! Deliberate deviations from the sidecar flags (see the S1 report DA table):
//! - `--wid` / `--input-ipc-server`: no libmpv equivalent (no window, no pipe).
//! - `--vo=gpu-next,gpu` -> `vo=libmpv` (S2 DA): the `libmpv` VO is the one
//!   that renders through the S2 render context. It is NOT optional and NOT
//!   auto-selected: mpv's autoprobe walks its driver list in order and
//!   `gpu-next` comes before `libmpv`, so with `vo` unset mpv happily opens a
//!   real window (measured 2026-10-09: `current-vo=gpu-next`, visible window
//!   count 0 -> 1 during the S2 diagnostic run). With `vo=libmpv` and no
//!   render context the VO fails loudly instead of falling back to a window —
//!   and engine.rs creates the render context at spawn, before any playback.
//!   The `libmpv` VO itself never creates a window (vo_libmpv.c renders only
//!   through the render context); the no-window invariant is test-enforced.
//! - `--log-file`: replaced by in-app logging of `mpv_request_log_messages`.
//! - `--no-terminal` -> `terminal=no` (flag spelling; same effect).
//!
//! Applied with `mpv_set_option_string` BEFORE `mpv_initialize` (client.h
//! requires the player-operation-mode option at that point).

/// The exact option set, in application order.
pub(crate) const ENGINE_OPTIONS: &[(&str, &str)] = &[
    // The render context is the video output (see the module docs above).
    ("vo", "libmpv"),
    ("hwdec", "auto-safe"),
    ("terminal", "no"),
    // Never read the user's %APPDATA%\mpv\mpv.conf / watch-later state: e.g. a
    // stray `pause=yes` would freeze every track drplay loads.
    ("config", "no"),
    // User scripts run arbitrary code inside the engine: stay a pure engine.
    ("load-scripts", "no"),
    ("idle", "yes"),
    ("gapless-audio", "yes"),
    ("prefetch-playlist", "no"),
    ("demuxer-readahead-secs", "30"),
    // The demuxer window above is seconds-based, but the stream-cache layer
    // (cache=yes, default cache-secs ~1000h) would read ahead unbounded; cap
    // it at the same 30s window so RAM stays predictable for heavy files.
    ("cache-secs", "30"),
    // Resume quickly after a seek/underrun: the upstream TTFB already
    // dominates, so don't add a full second of resume-wait on top.
    ("cache-pause-wait", "0.2"),
    // Narrow demuxer windows keep RAM low for large files. Backward seeks past
    // the back-buffer are cheap: streams are served through the localhost
    // proxy, which returns proper 206 Range responses.
    ("demuxer-max-back-bytes", "8MiB"),
    ("demuxer-max-bytes", "64MiB"),
    ("cache", "yes"),
    // Windows SMTC is app-owned (src/media_controls.rs): mpv must not register
    // a second session nor grab the media keys.
    ("media-controls", "no"),
    ("input-media-keys", "no"),
    // ---- mpv's OWN UI, suppressed (React is the only player UI) ------------
    ("osc", "no"),
    ("osd-level", "0"),
    ("input-cursor", "no"),
    ("input-default-bindings", "no"),
    ("input-vo-keyboard", "no"),
    // The sidecar needed this AFTER --wid (which implies pseudo-gui); kept
    // unconditionally so the invariant is explicit.
    ("player-operation-mode", "cplayer"),
];

#[cfg(test)]
mod tests {
    use super::*;

    /// The ported set must be exactly the frozen list: sidecar flags that
    /// survive the migration. Flags with no libmpv equivalent (`wid`,
    /// `input-ipc-server`, `log-file`) must never sneak back in, and `vo` must
    /// be exactly `libmpv`: it is the only VO that renders through the S2
    /// render context (autoprobe would otherwise pick `gpu-next` and open a
    /// window — measured, see the module docs).
    #[test]
    fn engine_options_match_the_frozen_port_of_the_sidecar_flags() {
        let options = ENGINE_OPTIONS;
        let expected: &[(&str, &str)] = &[
            ("vo", "libmpv"),
            ("hwdec", "auto-safe"),
            ("terminal", "no"),
            ("config", "no"),
            ("load-scripts", "no"),
            ("idle", "yes"),
            ("gapless-audio", "yes"),
            ("prefetch-playlist", "no"),
            ("demuxer-readahead-secs", "30"),
            ("cache-secs", "30"),
            ("cache-pause-wait", "0.2"),
            ("demuxer-max-back-bytes", "8MiB"),
            ("demuxer-max-bytes", "64MiB"),
            ("cache", "yes"),
            ("media-controls", "no"),
            ("input-media-keys", "no"),
            ("osc", "no"),
            ("osd-level", "0"),
            ("input-cursor", "no"),
            ("input-default-bindings", "no"),
            ("input-vo-keyboard", "no"),
            ("player-operation-mode", "cplayer"),
        ];
        assert_eq!(options, expected, "the option set is frozen by the S1 slice");
        assert!(
            options.contains(&("vo", "libmpv")),
            "vo must be exactly libmpv (the render-context VO); anything else either discards frames or opens a window"
        );
        for forbidden in ["wid", "input-ipc-server", "log-file"] {
            assert!(
                !options.iter().any(|(name, _)| *name == forbidden),
                "{forbidden} has no libmpv equivalent and must not be ported"
            );
        }
    }
}
