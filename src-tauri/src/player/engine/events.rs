use std::ffi::{c_int, CStr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::super::events;
use super::super::ffi::{self, MpvEvent, MpvNode};
use super::{EngineError, SendHandle, WireState, EVENT_WAIT_TIMEOUT_SECS};
use crate::mpv::IpcMessage;

/// The engine's single event consumer. Owns `mpv_wait_event` for the whole
/// handle lifetime (client.h: only one thread may call it per handle), maps
/// every event to the frozen wire shapes and stops on the flag or on a core
/// shutdown.
pub(super) fn event_loop(api: Arc<ffi::Api>, handle: SendHandle, core: Arc<WireState>, stop: Arc<AtomicBool>) {
    loop {
        if stop.load(Ordering::SeqCst) {
            return;
        }
        // SAFETY: this thread is the only mpv_wait_event caller on the handle.
        // The returned event is valid until the next wait_event call, so every
        // branch below copies out what it needs before looping.
        let event = unsafe { (api.wait_event)(handle.0, EVENT_WAIT_TIMEOUT_SECS) };
        if event.is_null() {
            // client.h promises this never happens; treat it as engine loss.
            log::error!("[player] mpv_wait_event returned NULL; treating as engine loss");
            core.emit_close_once();
            return;
        }
        let event = unsafe { &*event };
        match event.event_id {
            ffi::MPV_EVENT_NONE => {} // timeout or wakeup: re-check the stop flag
            ffi::MPV_EVENT_SHUTDOWN => {
                // The core quit on its own (e.g. a `quit` command): surface the
                // loss exactly like the sidecar pipe close (silent when the
                // teardown was commanded), and stop accepting commands so the
                // next `mpv_spawn` replaces this engine instead of reusing a
                // dead one (the sidecar's dead-process reap, mirrored).
                stop.store(true, Ordering::SeqCst);
                core.emit_close_once();
                return;
            }
            ffi::MPV_EVENT_LOG_MESSAGE => dispatch_log(event),
            ffi::MPV_EVENT_PROPERTY_CHANGE => dispatch_property(event, &core),
            ffi::MPV_EVENT_END_FILE => dispatch_end_file(&api, event, &core),
            ffi::MPV_EVENT_FILE_LOADED | ffi::MPV_EVENT_PLAYBACK_RESTART => {
                // Why: the frontend needs BOTH names — `file-loaded` closes the
                // load window, `playback-restart` is the only proof that mpv's
                // playback chain is up (it fires once the output chain is
                // ready, also after a seek). The legacy IPC forwards the same
                // event names verbatim, so both engines speak one vocabulary.
                core.emit(named_event_message(event_name(&api, event.event_id)));
            }
            _ => {
                // Other events (seek, ...) are not part of the frozen wire
                // contract; the frontend ignores them.
            }
        }
    }
}

/// Warn/error log messages reach the app log; everything below warn was
/// filtered by `mpv_request_log_messages` already (belt and braces).
fn dispatch_log(event: &MpvEvent) {
    // SAFETY: LOG_MESSAGE events always carry an mpv_event_log_message*
    // (client.h mpv_event.data contract).
    let message = unsafe { &*(event.data as *const ffi::MpvEventLogMessage) };
    if message.text.is_null() {
        return;
    }
    let text = unsafe { CStr::from_ptr(message.text) }.to_string_lossy();
    let prefix = if message.prefix.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(message.prefix) }.to_string_lossy().into_owned()
    };
    let text = text.trim_end();
    match message.log_level {
        ffi::MPV_LOG_LEVEL_FATAL | ffi::MPV_LOG_LEVEL_ERROR => {
            log::error!("[mpv] {prefix}: {text}")
        }
        ffi::MPV_LOG_LEVEL_WARN => log::warn!("[mpv] {prefix}: {text}"),
        _ => {}
    }
}

fn dispatch_property(event: &MpvEvent, core: &WireState) {
    // SAFETY: PROPERTY_CHANGE events always carry an mpv_event_property*.
    let property = unsafe { &*(event.data as *const ffi::MpvEventProperty) };
    if property.name.is_null() {
        return; // cannot name the property: nothing the wire could carry
    }
    let name = unsafe { CStr::from_ptr(property.name) }.to_string_lossy().into_owned();
    let data = if property.format == ffi::MPV_FORMAT_NODE && !property.data.is_null() {
        // SAFETY: NODE format means data points to an mpv_node valid until the
        // next wait_event; it is converted (copied) before returning.
        let node = unsafe { &*(property.data as *const MpvNode) };
        match events::node_to_json(node) {
            Ok(value) => value,
            Err(convert_error) => {
                // Never kill the event stream over one bad value; the wire
                // still gets a null, like mpv's own writer would produce.
                log::warn!("[player] property {name} node conversion failed: {convert_error}");
                Value::Null
            }
        }
    } else {
        // MPV_FORMAT_NONE = unavailable; the legacy IPC node omits `data`,
        // which the wire parser turns into null (mpv/ipc/wire.rs:35).
        Value::Null
    };
    core.emit(IpcMessage::PropertyChange { name, data });
}

fn dispatch_end_file(api: &ffi::Api, event: &MpvEvent, core: &WireState) {
    // SAFETY: END_FILE events always carry an mpv_event_end_file*.
    let end_file = unsafe { &*(event.data as *const ffi::MpvEventEndFile) };
    let (reason, error) =
        events::end_file_payload(end_file.reason, end_file.error, |code| mpv_error_message(api, code));
    core.emit(IpcMessage::MpvEvent {
        event: event_name(api, event.event_id),
        reason: Some(reason),
        error,
    });
}

/// The wire message for an mpv event that carries no payload beyond its name
/// (pure — the caller resolves the name from mpv itself, so the string is
/// byte-identical with the legacy IPC's verbatim event name).
pub(super) fn named_event_message(event: String) -> IpcMessage {
    IpcMessage::MpvEvent {
        event,
        reason: None,
        error: None,
    }
}

/// Wire event name from mpv itself (e.g. `end-file`, `file-loaded`), exactly
/// the strings the IPC layer would have emitted.
fn event_name(api: &ffi::Api, event_id: ffi::MpvEventId) -> String {
    // SAFETY: plain extern getter; the returned string is static.
    let pointer = unsafe { (api.event_name)(event_id) };
    if pointer.is_null() {
        return format!("unknown-{event_id}");
    }
    unsafe { CStr::from_ptr(pointer) }.to_string_lossy().into_owned()
}

pub(super) fn mpv_error_message(api: &ffi::Api, code: c_int) -> String {
    // SAFETY: plain extern getter; the returned string is static.
    let pointer = unsafe { (api.error_string)(code) };
    if pointer.is_null() {
        return format!("unknown error {code}");
    }
    unsafe { CStr::from_ptr(pointer) }.to_string_lossy().into_owned()
}

pub(super) fn join_with_timeout(
    thread: JoinHandle<()>,
    timeout: Duration,
    thread_name: &str,
) -> Result<(), EngineError> {
    let deadline = Instant::now() + timeout;
    while !thread.is_finished() {
        if Instant::now() >= deadline {
            return Err(EngineError::EventThread {
                message: format!("{thread_name} did not stop within {timeout:?} after wakeup"),
            });
        }
        thread::sleep(Duration::from_millis(10));
    }
    thread.join().map_err(|_panic| EngineError::EventThread {
        message: format!("{thread_name} panicked during teardown"),
    })
}
