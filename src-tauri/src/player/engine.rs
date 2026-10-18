//! In-process libmpv engine: lifecycle, FFI call protocol, event thread and
//! wire-state bookkeeping (epoch/conn/shutdown), mirroring mpv/ipc.rs
//! semantics exactly (ipc/tests.rs is the reference for the wire cases).

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock, RwLockReadGuard, RwLockWriteGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::events;
use super::ffi::{self, MpvEvent, MpvNode};
use super::options;
use super::render::{
    RenderHost, RenderSurface, RENDER_INITIAL_HEIGHT, RENDER_INITIAL_WIDTH, RENDER_READY_TIMEOUT,
};
use crate::mpv::{EventSink, IpcMessage};

/// How long `mpv_wait_event` blocks before the loop re-checks the stop flag.
/// `mpv_wakeup()` interrupts it immediately on destroy, so this only bounds
/// the idle wakeup cadence.
const EVENT_WAIT_TIMEOUT_SECS: f64 = 1.0;
/// Bound for the event thread to observe the stop flag and exit. The wakeup
/// runs first, so this is a pathological-case guard, not a wait.
const EVENT_THREAD_JOIN_TIMEOUT: Duration = Duration::from_secs(2);
/// The one command whose reply advances the load epoch (mpv/ipc.rs:151-153).
const LOADFILE_COMMAND: &str = "loadfile";
/// Name of the event thread (observable via `GetThreadDescription`; the
/// integration tests use it to assert the thread lifecycle precisely).
pub(crate) const EVENT_THREAD_NAME: &str = "libmpv-events";
/// Log level requested from libmpv: warn and above reach the app log.
///
/// MIGRATION-ONLY (S7): `DRPLAY_MPV_LOG_LEVEL` overrides it. The default stays
/// "warn" because that is the shipping volume; the S4b diagnosis needed mpv's
/// OWN lines (`VO:`, `vd:`, `hwdec-current`), and "why is there no mpv log at
/// all" was itself an unanswerable question until this existed.
const REQUESTED_LOG_LEVEL: &str = "warn";
const LOG_LEVEL_ENV: &str = "DRPLAY_MPV_LOG_LEVEL";

/// The level to ask `mpv_request_log_messages` for. Read per engine so a test
/// or a diagnostic run never needs a rebuild.
fn requested_log_level() -> String {
    std::env::var(LOG_LEVEL_ENV).unwrap_or_else(|_| REQUESTED_LOG_LEVEL.to_string())
}

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

/// Borrowed `mpv_handle*` made shareable across Tauri threads and the event
/// thread. Safety: every consumer holds the engine's `ffi_lock` read guard
/// while calling FFI, teardown holds the write guard, and the event thread is
/// joined before `mpv_destroy` — so no call can race destruction.
#[derive(Clone, Copy)]
struct SendHandle(*mut ffi::MpvHandle);

unsafe impl Send for SendHandle {}
unsafe impl Sync for SendHandle {}

/// One `FnOnce` teardown step run under the write guard BEFORE
/// `mpv_destroy` (spec §18): S2 uses it to free the render context first.
/// Must not call back into the engine's command methods. A failure aborts
/// the teardown before `mpv_destroy` (a render thread that will not stop must
/// never be left calling into a destroyed core).
pub(crate) type TeardownHook = Box<dyn FnOnce(&Engine) -> Result<(), EngineError> + Send + 'static>;

/// The in-process engine singleton held by the dispatcher.
pub(crate) struct Engine {
    api: Arc<ffi::Api>,
    handle: SendHandle,
    core: Arc<WireState>,
    /// Serializes FFI calls (read) against teardown (write): commands hold the
    /// read guard across the whole FFI call; `destroy` takes the write guard.
    ffi_lock: RwLock<()>,
    /// True from `destroy` start on: rejects new commands and stops the event
    /// thread loop.
    shutdown_flag: Arc<AtomicBool>,
    destroyed: AtomicBool,
    event_thread: Mutex<Option<JoinHandle<()>>>,
    teardown_hooks: Mutex<Vec<TeardownHook>>,
    /// S2: the GL render context. Set during `setup_player` (after
    /// `mpv_initialize`, before the engine is handed out); a successfully
    /// created engine always has one — creation fails without it.
    render: OnceLock<Arc<RenderSurface>>,
}

impl Engine {
    /// Load the DLL, create + initialize the player, apply the frozen option
    /// set, observe the contract property set and start the event thread.
    /// Headless render (no composition target): the S1/S2 test path.
    #[allow(dead_code)] // test entry point; production uses create_with_window
    pub(crate) fn create(sink: EventSink) -> Result<Arc<Engine>, EngineError> {
        Self::create_with_window(sink, None)
    }

    /// S3: composition-enabled variant. `hwnd` = the main window the
    /// DirectComposition target is bound to. `None` keeps the S2 headless
    /// render (tests); production always passes the main window handle.
    pub(crate) fn create_with_window(
        sink: EventSink,
        hwnd: Option<usize>,
    ) -> Result<Arc<Engine>, EngineError> {
        let dll = ffi::resolve_libmpv_dll()?;
        log::info!("[player] loading libmpv from {}", dll.display());
        let api = Arc::new(ffi::Api::load(&dll)?);
        // SAFETY: plain extern constructor; the NULL result is checked.
        let handle = unsafe { (api.create)() };
        if handle.is_null() {
            return Err(EngineError::Create);
        }
        let engine = Arc::new(Engine {
            api: Arc::clone(&api),
            handle: SendHandle(handle),
            core: Arc::new(WireState::new(sink)),
            ffi_lock: RwLock::new(()),
            shutdown_flag: Arc::new(AtomicBool::new(false)),
            destroyed: AtomicBool::new(false),
            event_thread: Mutex::new(None),
            teardown_hooks: Mutex::new(Vec::new()),
            render: OnceLock::new(),
        });
        // Fail loud AND clean: a half-set-up engine must not leak its handle.
        if let Err(setup_error) = engine.setup_player(&dll, hwnd) {
            // Spec §18: mpv must never be destroyed while a render context
            // (and its GL context) is alive. When the render surface was
            // spawned, its shutdown either joined the thread (the handle can
            // be released safely) or timed out — in which case the handle is
            // intentionally left alive, exactly like a stuck event thread in
            // `destroy`.
            let render_stopped = match engine.render.get() {
                Some(surface) => match surface.shutdown() {
                    Ok(()) => true,
                    Err(shutdown_error) => {
                        log::error!(
                            "[player] render surface did not stop after failed setup: {shutdown_error}"
                        );
                        false
                    }
                },
                None => true,
            };
            if render_stopped {
                engine.release_handle();
            } else {
                log::error!(
                    "[player] leaking the mpv handle of a failed engine: the render thread is still alive (spec §18)"
                );
            }
            return Err(setup_error);
        }
        let surface = Arc::clone(engine.render.get().expect("setup_player sets the render surface"));
engine.add_teardown_hook(Box::new(move |_engine| surface.shutdown()));
log::info!("[player] libmpv engine created (conn {})", engine.conn());
        Ok(engine)
    }

    /// Options -> initialize -> render context -> log messages -> observations
    /// -> event thread. Every failure names the exact option/property/step
    /// that failed. `hwnd` attaches the S3 composition pipeline (main window).
    fn setup_player(&self, dll: &Path, hwnd: Option<usize>) -> Result<(), EngineError> {
        for &(name, value) in options::ENGINE_OPTIONS {
            let name_c = CString::new(name).expect("static option name is NUL-free");
            let value_c = CString::new(value).expect("static option value is NUL-free");
            // SAFETY: both C strings are NUL-terminated; the handle is live.
            let code = unsafe {
                (self.api.set_option_string)(self.handle.0, name_c.as_ptr(), value_c.as_ptr())
            };
            if code < 0 {
                return Err(EngineError::Option {
                    name: name.to_string(),
                    code,
                    message: mpv_error_message(&self.api, code),
                });
            }
        }
        // SAFETY: handle from mpv_create, not yet initialized.
        let code = unsafe { (self.api.initialize)(self.handle.0) };
        if code < 0 {
            return Err(EngineError::Initialize {
                code,
                message: mpv_error_message(&self.api, code),
            });
        }
        // S2: the GL render context is created (and waited for) BEFORE the
        // engine is handed out. Video initialization then always finds the
        // render context ready, so no window-creating VO can ever be picked.
        // S3: the same render thread also builds the D3D11/DComp pipeline when
        // a window is attached — its init failure fails engine creation.
        let surface = RenderSurface::spawn(
            RenderHost(self.handle.0),
            dll.to_path_buf(),
            RENDER_INITIAL_WIDTH,
            RENDER_INITIAL_HEIGHT,
            hwnd,
        )?;
        let _ = self.render.set(Arc::clone(&surface));
        surface.wait_ready(RENDER_READY_TIMEOUT)?;
        let level = CString::new(requested_log_level()).expect("log level is NUL-free");
        // SAFETY: NUL-terminated level string; initialized handle.
        let code = unsafe { (self.api.request_log_messages)(self.handle.0, level.as_ptr()) };
        if code < 0 {
            return Err(EngineError::RequestLogMessages {
                code,
                message: mpv_error_message(&self.api, code),
            });
        }
        for &(observe_id, property) in crate::mpv::OBSERVED_PROPERTIES {
            let property_c = CString::new(property).expect("static observed property is NUL-free");
            // SAFETY: NUL-terminated name; NODE is a supported observe format.
            let code = unsafe {
                (self.api.observe_property)(
                    self.handle.0,
                    observe_id,
                    property_c.as_ptr(),
                    ffi::MPV_FORMAT_NODE,
                )
            };
            if code < 0 {
                return Err(EngineError::Observe {
                    property: property.to_string(),
                    code,
                    message: mpv_error_message(&self.api, code),
                });
            }
        }
        // The event thread starts LAST: it consumes the queue only once every
        // observation is registered, so no change can be missed or reordered.
        let thread = {
            let api = Arc::clone(&self.api);
            let core = Arc::clone(&self.core);
            let stop = Arc::clone(&self.shutdown_flag);
            let handle = self.handle;
            std::thread::Builder::new()
                .name(EVENT_THREAD_NAME.to_string())
                .spawn(move || event_loop(api, handle, core, stop))
                .map_err(|spawn_error| EngineError::EventThread {
                    message: format!("cannot spawn the event thread: {spawn_error}"),
                })?
        };
        *self.event_thread.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(thread);
        Ok(())
    }

    /// Destroy the raw handle of an engine whose setup failed. No event
    /// thread exists yet on that path, so no join is needed.
    fn release_handle(&self) {
        // SAFETY: this engine owns the handle and never started its thread.
        unsafe { (self.api.destroy)(self.handle.0) };
    }

    pub(crate) fn conn(&self) -> u64 {
        self.core.conn()
    }

    /// True while commands are still accepted (before any destroy).
    pub(crate) fn is_alive(&self) -> bool {
        !self.destroyed.load(Ordering::SeqCst) && !self.shutdown_flag.load(Ordering::SeqCst)
    }

    /// Register a teardown step (S2 render-context free). Runs under the write
    /// guard, before `mpv_destroy`, on the destroying thread.
    pub(crate) fn add_teardown_hook(&self, hook: TeardownHook) {
        self.teardown_hooks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(hook);
    }

    /// The render surface created during setup. Present on every successfully
    /// created engine; `None` only while setup is failing.
    #[allow(dead_code)] // S3 wires the surface pipeline; the render tests drive it today
    pub(crate) fn render_surface(&self) -> Option<&Arc<RenderSurface>> {
        self.render.get()
    }

    /// True while the render thread owns a live mpv render context.
    #[allow(dead_code)] // read-only diagnostic accessor (render tests today)
    pub(crate) fn render_ready(&self) -> bool {
        self.render.get().map(|surface| surface.is_ready()).unwrap_or(false)
    }

    /// Frames the render thread has rendered into its FBO (ENGINE-004).
    #[allow(dead_code)] // read-only diagnostic accessor (render tests today)
    pub(crate) fn render_frame_count(&self) -> u64 {
        self.render.get().map(|surface| surface.frame_count()).unwrap_or(0)
    }

    /// Run one mpv command synchronously and return its result node plus the
    /// load epoch the caller must report. A `loadfile` bumps the epoch here,
    /// on the reply path (mpv/ipc.rs:144-163).
    ///
    /// `set_property` / `get_property` are NOT command-parser commands in mpv
    /// v0.41: the sidecar's JSON IPC handles them as client-API calls BEFORE
    /// the parser (input/ipc.c:194-246 of the adopted revision; the parser
    /// table renamed `set_property` to `set` and dropped `get_property`
    /// entirely — verified against the bundled sidecar on 2026-10-08).
    /// Mirroring the IPC special cases is what keeps the frozen command
    /// vocabulary (frontend: loadfile / seek / set_property) working.
    pub(crate) fn send_command(&self, args: &[String]) -> Result<CommandReply, EngineError> {
        let _guard = self.lock_read();
        self.ensure_running()?;
        // A new media item means the previous item's first-frame signal must not
        // count: re-arm the one-shot BEFORE the command goes out, so the next
        // present the render thread sees belongs to what is loading now. This is
        // a single atomic store (no GL, no mpv, no loop change) and it is a
        // no-op for an audio file.
        if args.first().map(String::as_str) == Some(LOADFILE_COMMAND) {
            if let Some(surface) = self.render.get() {
                surface.rearm_first_frame();
            }
        }
        match args.first().map(String::as_str).unwrap_or("") {
            "set_property" | "set_property_string" => self.set_property_node(args),
            "get_property" => self.get_property_reply(args),
            _ => self.run_mpv_command(args),
        }
    }

    /// IPC special-case parity (input/ipc.c:232-246): exactly 3 arguments; the
    /// value travels as an MPV_FORMAT_NODE built from the wire string, so
    /// "yes"/"no"/"1" parse exactly like the sidecar's.
    fn set_property_node(&self, args: &[String]) -> Result<CommandReply, EngineError> {
        let command = args.first().cloned().unwrap_or_default();
        if args.len() != 3 {
            return Err(EngineError::Command {
                command,
                code: ffi::MPV_ERROR_INVALID_PARAMETER,
                message: format!("set_property expects 3 arguments, got {}", args.len()),
            });
        }
        let name = CString::new(args[1].as_str()).map_err(|_nul| EngineError::Command {
            command: command.clone(),
            code: ffi::MPV_ERROR_INVALID_PARAMETER,
            message: "property name contains a NUL byte".to_string(),
        })?;
        let value = CString::new(args[2].as_str()).map_err(|_nul| EngineError::Command {
            command: command.clone(),
            code: ffi::MPV_ERROR_INVALID_PARAMETER,
            message: "property value contains a NUL byte".to_string(),
        })?;
        let mut node = MpvNode {
            u: ffi::MpvNodeUnion { string: value.as_ptr() as *mut c_char },
            format: ffi::MPV_FORMAT_STRING,
        };
        // SAFETY: name is NUL-terminated; the node borrows `value` (alive
        // through the call) and matches MPV_FORMAT_STRING.
        let code = unsafe {
            (self.api.set_property)(
                self.handle.0,
                name.as_ptr(),
                ffi::MPV_FORMAT_NODE,
                (&mut node as *mut MpvNode).cast::<c_void>(),
            )
        };
        if code < 0 {
            return Err(EngineError::Command {
                command,
                code,
                message: mpv_error_message(&self.api, code),
            });
        }
        // The legacy IPC reply for set_property carries no `data` (wire -> null)
        // and never bumps the load epoch.
        Ok(CommandReply { data: Value::Null, load_epoch: self.core.load_epoch() })
    }

    /// IPC special-case parity (input/ipc.c:194-212): exactly 2 arguments,
    /// reply data = the property node. The dedicated `mpv_get_property`
    /// command resolves through the same read path.
    fn get_property_reply(&self, args: &[String]) -> Result<CommandReply, EngineError> {
        if args.len() != 2 {
            return Err(EngineError::Command {
                command: "get_property".to_string(),
                code: ffi::MPV_ERROR_INVALID_PARAMETER,
                message: format!("get_property expects 2 arguments, got {}", args.len()),
            });
        }
        let data = self.read_property_node(&args[1])?;
        Ok(CommandReply { data, load_epoch: self.core.load_epoch() })
    }

    /// Read one mpv property as JSON (MPV_FORMAT_NODE -> serde_json::Value).
    pub(crate) fn get_property(&self, property: &str) -> Result<Value, EngineError> {
        let _guard = self.lock_read();
        self.ensure_running()?;
        self.read_property_node(property)
    }

    fn read_property_node(&self, property: &str) -> Result<Value, EngineError> {
        let name = CString::new(property).map_err(|_nul| EngineError::Property {
            property: property.to_string(),
            code: ffi::MPV_ERROR_INVALID_PARAMETER,
            message: "property name contains a NUL byte".to_string(),
        })?;
        let mut node = MpvNode::default();
        // SAFETY: name is NUL-terminated; node is an out-parameter we own.
        let code = unsafe {
            (self.api.get_property)(
                self.handle.0,
                name.as_ptr(),
                ffi::MPV_FORMAT_NODE,
                (&mut node as *mut MpvNode).cast::<c_void>(),
            )
        };
        if code < 0 {
            return Err(EngineError::Property {
                property: property.to_string(),
                code,
                message: mpv_error_message(&self.api, code),
            });
        }
        let value = events::node_to_json(&node);
        // SAFETY: mpv filled the node on success; free its contents on both
        // paths (conversion failure included).
        unsafe { (self.api.free_node_contents)(&mut node) };
        value
    }

    /// Everything else goes through the real command parser, exactly like the
    /// IPC `command` request does (input/ipc.c:350).
    fn run_mpv_command(&self, args: &[String]) -> Result<CommandReply, EngineError> {
        let command_name = args.first().map(String::as_str).unwrap_or("").to_string();
        let mut arguments: Vec<CString> = Vec::with_capacity(args.len());
        for argument in args {
            arguments.push(CString::new(argument.as_str()).map_err(|_nul| {
                EngineError::Command {
                    command: command_name.clone(),
                    code: ffi::MPV_ERROR_INVALID_PARAMETER,
                    message: "command argument contains a NUL byte".to_string(),
                }
            })?);
        }
        let mut pointers: Vec<*const c_char> =
            arguments.iter().map(|argument| argument.as_ptr()).collect();
        pointers.push(ptr::null());
        let mut result = MpvNode::default();
        // SAFETY: pointers are a NULL-terminated argv of valid C strings; the
        // result node is an out-parameter we own and free below.
        let code = unsafe { (self.api.command_ret)(self.handle.0, pointers.as_ptr(), &mut result) };
        if code < 0 {
            return Err(EngineError::Command {
                command: command_name,
                code,
                message: mpv_error_message(&self.api, code),
            });
        }
        let data = events::node_to_json(&result);
        // SAFETY: mpv filled the node on success; its contents are ours to
        // free. Freed on BOTH paths (conversion failure included).
        unsafe { (self.api.free_node_contents)(&mut result) };
        let data = data?;
        let load_epoch = self.core.note_command_reply(&command_name);
        Ok(CommandReply { data, load_epoch })
    }

    /// Ordered teardown: stop the event thread, run teardown hooks, destroy
    /// the player handle. Idempotent. `commanded` = the app asked for it
    /// (silent); false = engine loss (`ipc-closed` emitted once).
    pub(crate) fn destroy(&self, commanded: bool) -> Result<(), EngineError> {
        if self.destroyed.swap(true, Ordering::SeqCst) {
            return Ok(()); // idempotent: exactly one teardown per engine
        }
        if commanded {
            self.core.mark_shutdown_requested();
        }
        // Stop the event thread BEFORE touching the handle: set the flag, wake
        // the blocked mpv_wait_event, then join. Destroying the handle under a
        // blocked wait_event is avoided by construction (client.h threading).
        self.shutdown_flag.store(true, Ordering::SeqCst);
        // SAFETY: mpv_wakeup is thread-safe and only unblocks wait_event.
        unsafe { (self.api.wakeup)(self.handle.0) };
        if let Some(thread) = self.event_thread.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take() {
            // A thread that does not exit leaves the handle alive on purpose:
            // destroying it while a wait_event may still be inside is worse.
            join_with_timeout(thread, EVENT_THREAD_JOIN_TIMEOUT, EVENT_THREAD_NAME)?;
        }
        if !commanded {
            // Engine loss must surface exactly like the sidecar pipe close did
            // (mpv/ipc.rs read_loop). At most once across repeated destroys.
            self.core.emit_close_once();
        }
        // Write guard: waits out any in-flight command FFI call. New commands
        // are already rejected by shutdown_flag.
        let _guard = self.lock_write();
        let hooks = std::mem::take(
            &mut *self.teardown_hooks.lock().unwrap_or_else(std::sync::PoisonError::into_inner),
        );
        for hook in hooks {
            // S2: render context free BEFORE mpv_destroy (spec §18). A hook
            // failure (a render thread that will not stop) aborts the teardown
            // here — destroying mpv under a live render thread is worse than
            // leaking the handle.
            hook(self)?;
        }
        // SAFETY: last owner of the handle; no FFI call or wait_event can
        // race this (joined thread + write guard).
        unsafe { (self.api.destroy)(self.handle.0) };
        log::info!(
            "[player] libmpv engine destroyed (conn {}, commanded={commanded})",
            self.core.conn()
        );
        Ok(())
    }

    fn lock_read(&self) -> RwLockReadGuard<'_, ()> {
        self.ffi_lock.read().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn lock_write(&self) -> RwLockWriteGuard<'_, ()> {
        self.ffi_lock.write().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn ensure_running(&self) -> Result<(), EngineError> {
        if self.shutdown_flag.load(Ordering::SeqCst) {
            return Err(EngineError::NotRunning);
        }
        Ok(())
    }
}

/// The engine's single event consumer. Owns `mpv_wait_event` for the whole
/// handle lifetime (client.h: only one thread may call it per handle), maps
/// every event to the frozen wire shapes and stops on the flag or on a core
/// shutdown.
fn event_loop(api: Arc<ffi::Api>, handle: SendHandle, core: Arc<WireState>, stop: Arc<AtomicBool>) {
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
            ffi::MPV_EVENT_FILE_LOADED => {
                core.emit(IpcMessage::MpvEvent {
                    event: event_name(&api, event.event_id),
                    reason: None,
                    error: None,
                });
            }
            _ => {
                // Other events (seek, playback-restart, ...) are not part of
                // the frozen wire contract; the frontend ignores them.
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

fn mpv_error_message(api: &ffi::Api, code: c_int) -> String {
    // SAFETY: plain extern getter; the returned string is static.
    let pointer = unsafe { (api.error_string)(code) };
    if pointer.is_null() {
        return format!("unknown error {code}");
    }
    unsafe { CStr::from_ptr(pointer) }.to_string_lossy().into_owned()
}

fn join_with_timeout(
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

/// Reply of `mpv_command`: the command's data plus the load epoch current at
/// reply time (the contract's `{data, load_epoch}`).
#[derive(Debug)]
pub(crate) struct CommandReply {
    pub(crate) data: Value,
    pub(crate) load_epoch: u64,
}

#[cfg(test)]
mod tests;
