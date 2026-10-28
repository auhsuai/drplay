//! Engine creation, the mpv option/observation setup order, and the ordered
//! teardown (event thread -> hooks -> `mpv_destroy`). The teardown order is a
//! hard invariant (spec §18): never merge or reorder its steps.

use std::ffi::CString;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use super::super::ffi;
use super::super::options;
use super::super::render::{
    RenderHost, RenderSurface, RENDER_INITIAL_HEIGHT, RENDER_INITIAL_WIDTH, RENDER_READY_TIMEOUT,
};
use super::events::{event_loop, join_with_timeout, mpv_error_message};
use super::{Engine, EngineError, SendHandle, WireState, EVENT_THREAD_NAME};
use crate::mpv::EventSink;

/// Bound for the event thread to observe the stop flag and exit. The wakeup
/// runs first, so this is a pathological-case guard, not a wait.
const EVENT_THREAD_JOIN_TIMEOUT: Duration = Duration::from_secs(2);
/// Ordered teardown state of one engine. The transitions are monotonic and
/// never regress, so a FAILED teardown can never be mistaken for a clean stop:
/// reporting STOPPED while the render thread may still own the handle is what
/// let a replacement engine start and play over the old one.
const LIFECYCLE_RUNNING: u8 = 0;
const LIFECYCLE_TEARING_DOWN: u8 = 1;
const LIFECYCLE_STOPPED: u8 = 2;
const LIFECYCLE_FAILED: u8 = 3;
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
            ffi_lock: std::sync::RwLock::new(()),
            shutdown_flag: Arc::new(AtomicBool::new(false)),
            lifecycle: AtomicU8::new(LIFECYCLE_RUNNING),
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

    /// True while commands are still accepted (before any destroy).
    pub(crate) fn is_alive(&self) -> bool {
        self.lifecycle.load(Ordering::SeqCst) == LIFECYCLE_RUNNING
            && !self.shutdown_flag.load(Ordering::SeqCst)
    }

    /// True after a teardown failed. The handle was deliberately not released,
    /// so a replacement engine must never be created over it.
    pub(crate) fn teardown_failed(&self) -> bool {
        self.lifecycle.load(Ordering::SeqCst) == LIFECYCLE_FAILED
    }

    /// True only once the native teardown completed. Anything else (running,
    /// tearing down, failed) means the handle may still be usable.
    pub(crate) fn is_stopped(&self) -> bool {
        self.lifecycle.load(Ordering::SeqCst) == LIFECYCLE_STOPPED
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

    /// Ordered teardown: stop the event thread, run teardown hooks, destroy
    /// the player handle. Idempotent on success ONLY: a second call while the
    /// first teardown runs is rejected, and an engine whose teardown failed
    /// keeps returning that failure — never a fake success (reporting Ok while
    /// the old handle may still be alive is what allows a second engine).
    /// `commanded` = the app asked for it (silent); false = engine loss
    /// (`ipc-closed` emitted once).
    pub(crate) fn destroy(&self, commanded: bool) -> Result<(), EngineError> {
        match self.lifecycle.load(Ordering::SeqCst) {
            LIFECYCLE_STOPPED => return Ok(()),
            LIFECYCLE_FAILED => return Err(EngineError::TeardownFailed),
            LIFECYCLE_TEARING_DOWN => return Err(EngineError::TeardownInProgress),
            _ => {}
        }
        if self
            .lifecycle
            .compare_exchange(
                LIFECYCLE_RUNNING,
                LIFECYCLE_TEARING_DOWN,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_err()
        {
            return Err(EngineError::TeardownInProgress);
        }
        let outcome = self.run_teardown(commanded);
        self.lifecycle.store(
            if outcome.is_ok() {
                LIFECYCLE_STOPPED
            } else {
                LIFECYCLE_FAILED
            },
            Ordering::SeqCst,
        );
        outcome
    }

    fn run_teardown(&self, commanded: bool) -> Result<(), EngineError> {
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
}
