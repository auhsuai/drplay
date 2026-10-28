use std::ffi::c_int;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use serde_json::Value;

use crate::mpv::{EventSink, IpcMessage};

/// The one command whose reply advances the load epoch (mpv/ipc.rs:151-153).
pub(super) const LOADFILE_COMMAND: &str = "loadfile";

/// Every engine failure path, with the context needed to diagnose it.
#[derive(Debug)]
pub(crate) enum EngineError {
    Load { path: PathBuf, message: String },
    Symbol { name: String, message: String },
    ApiVersion { found: std::ffi::c_ulong, required: std::ffi::c_ulong },
    Create,
    Initialize { code: c_int, message: String },
    Option { name: String, code: c_int, message: String },
    Observe { property: String, code: c_int, message: String },
    RequestLogMessages { code: c_int, message: String },
    Command { command: String, code: c_int, message: String },
    Property { property: String, code: c_int, message: String },
    Convert { message: String },
    NotRunning,
    EventThread { message: String },
    /// The GL/WGL layer or the mpv render context could not be set up, or a
    /// resize/sample on the render thread failed.
    Render { message: String },
    /// The render thread refused to stop within the join timeout. The mpv
    /// handle is intentionally left alive in that case (spec §18).
    RenderThread { message: String },
    /// A second teardown reached an engine while the first one is still
    /// running. The caller must wait for that teardown, never assume success.
    TeardownInProgress,
    /// An earlier teardown failed: the handle was deliberately NOT released
    /// and may still be alive. A second engine must never be created over it.
    TeardownFailed,
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EngineError::Load { path, message } => {
                write!(formatter, "libmpv: cannot load {}: {message}", path.display())
            }
            EngineError::Symbol { name, message } => {
                write!(formatter, "libmpv: missing symbol {name}: {message}")
            }
            EngineError::ApiVersion { found, required } => write!(
                formatter,
                "libmpv: client API version {found} is older than the required {required}"
            ),
            EngineError::Create => write!(formatter, "libmpv: mpv_create returned NULL"),
            EngineError::Initialize { code, message } => write!(
                formatter,
                "libmpv: mpv_initialize failed ({message}, code {code})"
            ),
            EngineError::Option { name, code, message } => write!(
                formatter,
                "libmpv: option {name} rejected ({message}, code {code})"
            ),
            EngineError::Observe { property, code, message } => write!(
                formatter,
                "libmpv: observe_property({property}) failed ({message}, code {code})"
            ),
            EngineError::RequestLogMessages { code, message } => write!(
                formatter,
                "libmpv: request_log_messages failed ({message}, code {code})"
            ),
            EngineError::Command { command, code, message } => write!(
                formatter,
                "libmpv: command {command} failed ({message}, code {code})"
            ),
            EngineError::Property { property, code, message } => write!(
                formatter,
                "libmpv: get_property({property}) failed ({message}, code {code})"
            ),
            EngineError::Convert { message } => write!(formatter, "libmpv: node conversion: {message}"),
            EngineError::NotRunning => write!(formatter, "mpv engine is not running"),
            EngineError::EventThread { message } => write!(formatter, "libmpv event thread: {message}"),
            EngineError::Render { message } => write!(formatter, "libmpv render: {message}"),
            EngineError::RenderThread { message } => {
                write!(formatter, "libmpv render thread: {message}")
            }
            EngineError::TeardownInProgress => {
                write!(formatter, "libmpv engine teardown is already in progress")
            }
            EngineError::TeardownFailed => write!(
                formatter,
                "a previous libmpv engine teardown failed; the old handle may still be alive"
            ),
        }
    }
}

impl std::error::Error for EngineError {}

impl EngineError {
    /// The string the frozen wire contract exposes for mpv error codes
    /// (legacy: mpv/ipc.rs:274 `format!("mpv error: {}", reply.error)`).
    pub(crate) fn wire_message(&self) -> String {
        match self {
            EngineError::Command { message, .. } | EngineError::Property { message, .. } => {
                format!("mpv error: {message}")
            }
            other => other.to_string(),
        }
    }
}

/// Process-wide connection id source (R2.2): never reset, so events of a
/// replaced engine can never alias a newer engine's identity. Deliberately
/// separate from mpv/ipc.rs's counter: that module is not part of this slice.
static NEXT_CONNECTION_ID: AtomicU64 = AtomicU64::new(1);

fn next_connection_id() -> u64 {
    NEXT_CONNECTION_ID.fetch_add(1, Ordering::SeqCst)
}

/// Wire bookkeeping shared by command threads and the event thread: mirrors
/// IpcCore's epoch/conn/shutdown semantics (mpv/ipc.rs:73-171) minus the pipe
/// machinery — synchronous FFI calls need no pending map or request ids.
pub(crate) struct WireState {
    conn: u64,
    load_epoch: AtomicU64,
    shutdown_requested: AtomicBool,
    close_emitted: AtomicBool,
    sink: EventSink,
}

impl WireState {
    pub(crate) fn new(sink: EventSink) -> Self {
        Self {
            conn: next_connection_id(),
            load_epoch: AtomicU64::new(0),
            shutdown_requested: AtomicBool::new(false),
            close_emitted: AtomicBool::new(false),
            sink,
        }
    }

    pub(crate) fn conn(&self) -> u64 {
        self.conn
    }

    /// Epoch of the latest dispatched `loadfile` reply (0 before the first).
    pub(crate) fn load_epoch(&self) -> u64 {
        self.load_epoch.load(Ordering::SeqCst)
    }

    /// Mark a deliberately commanded shutdown: the teardown that follows is
    /// expected and must NOT surface as the `ipc-closed` engine failure.
    pub(crate) fn mark_shutdown_requested(&self) {
        self.shutdown_requested.store(true, Ordering::SeqCst);
    }

    pub(crate) fn is_shutdown_requested(&self) -> bool {
        self.shutdown_requested.load(Ordering::SeqCst)
    }

    /// Tag and forward one message with the epoch current at dispatch time
    /// (mirrors ipc.rs:164).
    pub(crate) fn emit(&self, message: IpcMessage) {
        (self.sink)(message, self.load_epoch(), self.conn);
    }

    /// Emit the un-commanded engine-loss signal at most once; silent after a
    /// commanded shutdown. Returns true when this call emitted.
    pub(crate) fn emit_close_once(&self) -> bool {
        if self.close_emitted.swap(true, Ordering::SeqCst) {
            return false; // already reported (or consumed by a commanded path)
        }
        if self.is_shutdown_requested() {
            return false; // commanded: the teardown is expected, stay silent
        }
        self.emit(IpcMessage::ConnectionClosed { cause: "eof".to_string() });
        true
    }

    /// Advance the load epoch on a completed command reply. Bump BEFORE the
    /// caller reads it back (ipc.rs:151-153 bumps on the reply path), so the
    /// loadfile reply itself already carries the new epoch and every event
    /// dispatched after it carries the new value.
    pub(crate) fn note_command_reply(&self, command: &str) -> u64 {
        if command == LOADFILE_COMMAND {
            self.load_epoch.fetch_add(1, Ordering::SeqCst);
        }
        self.load_epoch()
    }
}

/// Reply of `mpv_command`: the command's data plus the load epoch current at
/// reply time (the contract's `{data, load_epoch}`).
#[derive(Debug)]
pub(crate) struct CommandReply {
    pub(crate) data: Value,
    pub(crate) load_epoch: u64,
}
