//! Windows System Media Transport Controls (SMTC) integration owned by the app.
//!
//! Why the app owns the session: audio plays through the mpv sidecar, whose
//! own SMTC session (`mpv --media-controls`, default on) knew nothing about
//! the app queue — the flyout showed no track metadata and its next/prev
//! buttons only walked mpv's single-entry playlist. The sidecar now spawns
//! with `--media-controls=no` (mpv/process.rs), so this module is the only
//! session Windows shows for the app:
//!
//! - it registers the main window as the SMTC session (metadata, playback
//!   status, timeline, transport buttons);
//! - it forwards SMTC button/timeline actions to the frontend as the
//!   `media-control` event (the JS player owns queue + playback state, so no
//!   queue logic is duplicated here);
//! - it accepts state snapshots from the frontend (`media_controls_update`),
//!   each stamped with a monotonic `revision`: a snapshot that arrives after
//!   a newer one (out-of-order command execution) is dropped, so track A's
//!   metadata can never overwrite track B's.

use std::sync::Mutex;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};
use windows::core::{factory, HSTRING};
use windows::Foundation::{TimeSpan, TypedEventHandler};
use windows::Media::{
    MediaPlaybackStatus, MediaPlaybackType, SystemMediaTransportControls,
    SystemMediaTransportControlsButton, SystemMediaTransportControlsButtonPressedEventArgs,
    SystemMediaTransportControlsDisplayUpdater, SystemMediaTransportControlsTimelineProperties,
    PlaybackPositionChangeRequestedEventArgs,
};
use windows::Win32::System::WinRT::ISystemMediaTransportControlsInterop;

/// Frontend event carrying one OS media-control action.
pub const MEDIA_CONTROL_EVENT: &str = "media-control";
/// Window label declared in tauri.conf.json.
const MAIN_WINDOW_LABEL: &str = "main";
/// WinRT `TimeSpan` counts 100-nanosecond ticks.
const TIMESPAN_TICKS_PER_SECOND: f64 = 10_000_000.0;
/// Playback contract strings shared with `src/lib/mediaControls.ts`.
const PLAYBACK_PLAYING: &str = "playing";
const PLAYBACK_PAUSED: &str = "paused";

/// One player-state snapshot sent from the frontend.
#[derive(Debug, Clone, Deserialize)]
pub struct MediaControlsUpdate {
    /// Strictly increasing stamp; older revisions are ignored.
    pub revision: u64,
    pub title: Option<String>,
    pub artist: Option<String>,
    /// Track duration in seconds.
    pub duration: Option<f64>,
    /// `playing` | `paused` | `stopped`.
    pub playback: String,
    /// Playhead position in seconds.
    pub position: Option<f64>,
}

/// Live SMTC objects plus the last state applied from the frontend.
struct SmtcSession {
    controls: SystemMediaTransportControls,
    updater: SystemMediaTransportControlsDisplayUpdater,
    timeline: SystemMediaTransportControlsTimelineProperties,
    applied_revision: u64,
    /// Whether a track is loaded (playing/paused). An idle session reports
    /// `Closed` and has all transport buttons disabled, so the flyout does
    /// not list the app until media is loaded (mpv's own session behaved so).
    active: bool,
    /// Last published display text; position ticks repeat the snapshot every
    /// second and must not cause a COM round-trip unless the text changed.
    title: String,
    artist: String,
}

static SESSION: Mutex<Option<SmtcSession>> = Mutex::new(None);

/// Convert seconds to WinRT ticks, mapping non-finite/negative input to 0.
fn seconds_to_timespan(seconds: f64) -> TimeSpan {
    let clamped = if seconds.is_finite() && seconds > 0.0 {
        seconds
    } else {
        0.0
    };
    TimeSpan {
        Duration: (clamped * TIMESPAN_TICKS_PER_SECOND) as i64,
    }
}

/// Convert WinRT ticks back to seconds.
fn timespan_to_seconds(span: TimeSpan) -> f64 {
    span.Duration as f64 / TIMESPAN_TICKS_PER_SECOND
}

/// Map the frontend playback contract to the SMTC status. `None` means "no
/// track loaded": the session reports `Closed` and stays hidden.
fn playback_status(value: &str) -> Option<MediaPlaybackStatus> {
    match value {
        PLAYBACK_PLAYING => Some(MediaPlaybackStatus::Playing),
        PLAYBACK_PAUSED => Some(MediaPlaybackStatus::Paused),
        _ => None,
    }
}

/// Whether a snapshot's display text differs from the last applied one.
fn text_changed(previous: &str, next: &str) -> bool {
    previous != next
}

/// Log-friendly context for a WinRT call result.
fn winrt_context(action: &str, result: windows::core::Result<()>) -> Result<(), String> {
    result.map_err(|winrt_error| format!("media controls: {action}: {winrt_error}"))
}

/// Map one SMTC button to the action string sent to the frontend. Buttons the
/// app does not model (Record, ChannelUp, ...) return `None` and are ignored.
fn button_action(button: SystemMediaTransportControlsButton) -> Option<&'static str> {
    if button == SystemMediaTransportControlsButton::Play {
        Some("play")
    } else if button == SystemMediaTransportControlsButton::Pause {
        Some("pause")
    } else if button == SystemMediaTransportControlsButton::Stop {
        Some("stop")
    } else if button == SystemMediaTransportControlsButton::Next {
        Some("next")
    } else if button == SystemMediaTransportControlsButton::Previous {
        Some("previous")
    } else if button == SystemMediaTransportControlsButton::FastForward {
        Some("seek-forward")
    } else if button == SystemMediaTransportControlsButton::Rewind {
        Some("seek-backward")
    } else {
        None
    }
}

/// A snapshot is stale when it is not strictly newer than the applied one.
fn is_stale(incoming: u64, applied: u64) -> bool {
    incoming <= applied
}

/// Clamp a playhead to the known duration (0 = duration unknown, keep as-is).
fn timeline_position_seconds(position: f64, duration: f64) -> f64 {
    let position = if position.is_finite() && position > 0.0 {
        position
    } else {
        0.0
    };
    if duration > 0.0 {
        position.min(duration)
    } else {
        position
    }
}

/// Register the main window as the app's SMTC session and wire button events
/// to the `media-control` frontend event. Failure is non-fatal for the app:
/// the caller logs it and playback continues without a flyout.
pub fn init(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| format!("media controls: window '{MAIN_WINDOW_LABEL}' not found"))?;
    let hwnd = window
        .hwnd()
        .map_err(|hwnd_error| format!("media controls: cannot resolve main window HWND: {hwnd_error}"))?;

    let interop: ISystemMediaTransportControlsInterop =
        factory::<SystemMediaTransportControls, ISystemMediaTransportControlsInterop>()
            .map_err(|activation_error| format!("media controls: SMTC activation failed: {activation_error}"))?;
    // SAFETY: `interop` is the genuine SMTC activation factory and `hwnd`
    // belongs to this app's main window.
    let controls: SystemMediaTransportControls = unsafe { interop.GetForWindow(hwnd) }
        .map_err(|window_error| format!("media controls: GetForWindow failed: {window_error}"))?;

    let session = SmtcSession {
        updater: controls
            .DisplayUpdater()
            .map_err(|updater_error| format!("media controls: display updater unavailable: {updater_error}"))?,
        timeline: SystemMediaTransportControlsTimelineProperties::new()
            .map_err(|timeline_error| format!("media controls: timeline properties unavailable: {timeline_error}"))?,
        controls,
        applied_revision: 0,
        active: false,
        title: String::new(),
        artist: String::new(),
    };

    winrt_context("enable", session.controls.SetIsEnabled(true))?;
    winrt_context("set music type", session.updater.SetType(MediaPlaybackType::Music))?;
    // Idle start: no track is loaded, so the session reports Closed (Windows
    // does not list it in the flyout) with every transport button disabled.
    // The first snapshot carrying a loaded track flips both in apply_update.
    winrt_context(
        "set closed status",
        session.controls.SetPlaybackStatus(MediaPlaybackStatus::Closed),
    )?;
    for (action, result) in [
        ("disable play", session.controls.SetIsPlayEnabled(false)),
        ("disable pause", session.controls.SetIsPauseEnabled(false)),
        ("disable stop", session.controls.SetIsStopEnabled(false)),
        ("disable next", session.controls.SetIsNextEnabled(false)),
        ("disable previous", session.controls.SetIsPreviousEnabled(false)),
        ("disable fast-forward", session.controls.SetIsFastForwardEnabled(false)),
        ("disable rewind", session.controls.SetIsRewindEnabled(false)),
    ] {
        winrt_context(action, result)?;
    }

    // OS button presses -> frontend. WinRT may invoke the handler on any
    // thread; AppHandle is Send + Sync and `emit` is thread-safe.
    let button_app = app.clone();
    session
        .controls
        .ButtonPressed(&TypedEventHandler::new(
            move |_, args: windows::core::Ref<'_, SystemMediaTransportControlsButtonPressedEventArgs>| {
                let args = args.ok()?;
                let button = args.Button()?;
                if let Some(action) = button_action(button) {
                    emit_control(&button_app, action, None);
                }
                Ok(())
            },
        ))
        .map_err(|handler_error| format!("media controls: button handler unavailable: {handler_error}"))?;

    // Flyout timeline scrub -> frontend seek.
    let seek_app = app.clone();
    session
        .controls
        .PlaybackPositionChangeRequested(&TypedEventHandler::new(
            move |_, args: windows::core::Ref<'_, PlaybackPositionChangeRequestedEventArgs>| {
                let args = args.ok()?;
                emit_control(&seek_app, "seek", Some(timespan_to_seconds(args.RequestedPlaybackPosition()?)));
                Ok(())
            },
        ))
        .map_err(|handler_error| format!("media controls: position handler unavailable: {handler_error}"))?;

    let mut slot = SESSION
        .lock()
        .map_err(|lock_error| format!("media controls: session lock poisoned: {lock_error}"))?;
    if slot.is_some() {
        log::debug!("[media-controls] session already registered; init skipped");
        return Ok(());
    }
    *slot = Some(session);
    log::info!("[media-controls] SMTC session registered on window '{MAIN_WINDOW_LABEL}'");
    Ok(())
}

/// Tauri command: apply one player-state snapshot (revision-guarded).
#[tauri::command]
pub fn media_controls_update(update: MediaControlsUpdate) -> Result<(), String> {
    apply_update(update)
}

fn apply_update(update: MediaControlsUpdate) -> Result<(), String> {
    let mut slot = SESSION
        .lock()
        .map_err(|lock_error| format!("media controls: session lock poisoned: {lock_error}"))?;
    let session = slot
        .as_mut()
        .ok_or_else(|| "media controls: session not initialized".to_string())?;

    if is_stale(update.revision, session.applied_revision) {
        // Out-of-order command execution: never let an older snapshot (track
        // A) overwrite a newer one (track B).
        log::debug!(
            "[media-controls] ignoring stale snapshot rev={} (applied={})",
            update.revision,
            session.applied_revision
        );
        return Ok(());
    }

    let status = playback_status(&update.playback);
    let active = status.is_some();
    if active != session.active {
        session.active = active;
        // Transport buttons follow the loaded/idle state: disabled while idle
        // (Closed session, hidden from the flyout), enabled while a track is
        // loaded. The JS player decides whether a command has an effect
        // (e.g. empty queue -> no-op).
        for (action, result) in [
            ("set play", session.controls.SetIsPlayEnabled(active)),
            ("set pause", session.controls.SetIsPauseEnabled(active)),
            ("set stop", session.controls.SetIsStopEnabled(active)),
            ("set next", session.controls.SetIsNextEnabled(active)),
            ("set previous", session.controls.SetIsPreviousEnabled(active)),
            ("set fast-forward", session.controls.SetIsFastForwardEnabled(active)),
            ("set rewind", session.controls.SetIsRewindEnabled(active)),
        ] {
            winrt_context(action, result)?;
        }
    }
    winrt_context(
        "set playback status",
        session
            .controls
            .SetPlaybackStatus(status.unwrap_or(MediaPlaybackStatus::Closed)),
    )?;

    let title = update.title.unwrap_or_default();
    let artist = update.artist.unwrap_or_default();
    if text_changed(&session.title, &title) || text_changed(&session.artist, &artist) {
        // COM round-trip only when the text actually changed: position ticks
        // repeat the same snapshot every second.
        let props = session
            .updater
            .MusicProperties()
            .map_err(|props_error| format!("media controls: music properties unavailable: {props_error}"))?;
        winrt_context("set title", props.SetTitle(&HSTRING::from(title.as_str())))?;
        winrt_context("set artist", props.SetArtist(&HSTRING::from(artist.as_str())))?;
        winrt_context("update display", session.updater.Update())?;
        session.title = title;
        session.artist = artist;
    }

    let duration = update.duration.unwrap_or(0.0);
    session
        .timeline
        .SetEndTime(seconds_to_timespan(duration))
        .map_err(|end_error| format!("media controls: timeline end failed: {end_error}"))?;
    session
        .timeline
        .SetMaxSeekTime(seconds_to_timespan(duration))
        .map_err(|max_error| format!("media controls: timeline max failed: {max_error}"))?;
    session
        .timeline
        .SetPosition(seconds_to_timespan(timeline_position_seconds(
            update.position.unwrap_or(0.0),
            duration,
        )))
        .map_err(|position_error| format!("media controls: timeline position failed: {position_error}"))?;
    session
        .controls
        .UpdateTimelineProperties(&session.timeline)
        .map_err(|timeline_error| format!("media controls: timeline update failed: {timeline_error}"))?;

    session.applied_revision = update.revision;
    Ok(())
}

fn emit_control(app: &AppHandle, action: &str, position: Option<f64>) {
    if let Err(emit_error) = app.emit(
        MEDIA_CONTROL_EVENT,
        serde_json::json!({ "action": action, "position": position }),
    ) {
        log::warn!("[media-controls] cannot emit '{action}': {emit_error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Foundation::TimeSpan;

    #[test]
    fn seconds_to_timespan_converts_and_clamps_invalid_input() {
        assert_eq!(seconds_to_timespan(1.5), TimeSpan { Duration: 15_000_000 });
        assert_eq!(seconds_to_timespan(0.0), TimeSpan { Duration: 0 });
        assert_eq!(seconds_to_timespan(-3.0), TimeSpan { Duration: 0 });
        assert_eq!(seconds_to_timespan(f64::NAN), TimeSpan { Duration: 0 });
        assert_eq!(seconds_to_timespan(f64::INFINITY), TimeSpan { Duration: 0 });
    }

    #[test]
    fn timespan_to_seconds_is_the_inverse() {
        assert_eq!(timespan_to_seconds(TimeSpan { Duration: 15_000_000 }), 1.5);
        assert_eq!(timespan_to_seconds(TimeSpan { Duration: 0 }), 0.0);
    }

    #[test]
    fn playback_status_maps_contract_strings() {
        assert_eq!(
            playback_status("playing"),
            Some(MediaPlaybackStatus::Playing)
        );
        assert_eq!(playback_status("paused"), Some(MediaPlaybackStatus::Paused));
        // No track loaded -> None -> session reports Closed (hidden).
        assert_eq!(playback_status("stopped"), None);
        assert_eq!(playback_status("garbage"), None);
    }

    #[test]
    fn text_changed_only_when_display_text_really_differs() {
        assert!(!text_changed("Song", "Song"));
        assert!(text_changed("Song A", "Song B"));
        assert!(text_changed("", "Song"));
        assert!(text_changed("Song", ""));
    }

    #[test]
    fn button_action_maps_transport_buttons_and_ignores_others() {
        assert_eq!(button_action(SystemMediaTransportControlsButton::Play), Some("play"));
        assert_eq!(button_action(SystemMediaTransportControlsButton::Pause), Some("pause"));
        assert_eq!(button_action(SystemMediaTransportControlsButton::Stop), Some("stop"));
        assert_eq!(button_action(SystemMediaTransportControlsButton::Next), Some("next"));
        assert_eq!(button_action(SystemMediaTransportControlsButton::Previous), Some("previous"));
        assert_eq!(
            button_action(SystemMediaTransportControlsButton::FastForward),
            Some("seek-forward")
        );
        assert_eq!(
            button_action(SystemMediaTransportControlsButton::Rewind),
            Some("seek-backward")
        );
        assert_eq!(button_action(SystemMediaTransportControlsButton::Record), None);
        assert_eq!(button_action(SystemMediaTransportControlsButton::ChannelUp), None);
    }

    #[test]
    fn stale_snapshots_are_rejected_by_revision() {
        assert!(is_stale(0, 0));
        assert!(is_stale(1, 1));
        assert!(is_stale(4, 5));
        assert!(!is_stale(6, 5));
        assert!(!is_stale(1, 0));
    }

    #[test]
    fn timeline_position_is_clamped_to_a_known_duration() {
        assert_eq!(timeline_position_seconds(120.0, 240.0), 120.0);
        assert_eq!(timeline_position_seconds(300.0, 240.0), 240.0);
        assert_eq!(timeline_position_seconds(-5.0, 240.0), 0.0);
        assert_eq!(timeline_position_seconds(42.0, 0.0), 42.0);
    }
}
