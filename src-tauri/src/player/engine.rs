//! In-process libmpv engine: lifecycle, FFI call protocol, event thread and
//! wire-state bookkeeping (epoch/conn/shutdown), mirroring mpv/ipc.rs
//! semantics exactly (ipc/tests.rs is the reference for the wire cases).

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock, RwLockReadGuard, RwLockWriteGuard};
use std::thread::JoinHandle;

use super::ffi;
use super::render::RenderSurface;

// Re-exported for `engine/tests.rs` (`use super::*`) and for the sibling
// modules: the wire shapes keep their old `crate::player::engine::*` paths.
pub(crate) use self::wire::{CommandReply, EngineError, WireState};
use self::wire::LOADFILE_COMMAND;
#[cfg(test)]
use crate::mpv::{EventSink, IpcMessage};

/// How long `mpv_wait_event` blocks before the loop re-checks the stop flag.
/// `mpv_wakeup()` interrupts it immediately on destroy, so this only bounds
/// the idle wakeup cadence.
pub(super) const EVENT_WAIT_TIMEOUT_SECS: f64 = 1.0;
/// Name of the event thread (observable via `GetThreadDescription`; the
/// integration tests use it to assert the thread lifecycle precisely).
pub(crate) const EVENT_THREAD_NAME: &str = "libmpv-events";

/// Borrowed `mpv_handle*` made shareable across Tauri threads and the event
/// thread. Safety: every consumer holds the engine's `ffi_lock` read guard
/// while calling FFI, teardown holds the write guard, and the event thread is
/// joined before `mpv_destroy` — so no call can race destruction.
#[derive(Clone, Copy)]
pub(super) struct SendHandle(*mut ffi::MpvHandle);

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
    /// Monotonic teardown state (see `LIFECYCLE_*`). `destroy` reports success
    /// only once the state reached STOPPED; a failed path stays FAILED forever.
    lifecycle: AtomicU8,
    event_thread: Mutex<Option<JoinHandle<()>>>,
    teardown_hooks: Mutex<Vec<TeardownHook>>,
    /// S2: the GL render context. Set during `setup_player` (after
    /// `mpv_initialize`, before the engine is handed out); a successfully
    /// created engine always has one — creation fails without it.
    render: OnceLock<Arc<RenderSurface>>,
}

impl Engine {
    pub(crate) fn conn(&self) -> u64 {
        self.core.conn()
    }

    /// Register a teardown step (S2 render-context free). Runs under the write
    /// guard, before `mpv_destroy`, on the destroying thread.
    pub(crate) fn add_teardown_hook(&self, hook: TeardownHook) {
        self.teardown_hooks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(hook);
    }

    pub(super) fn lock_read(&self) -> RwLockReadGuard<'_, ()> {
        self.ffi_lock.read().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub(super) fn lock_write(&self) -> RwLockWriteGuard<'_, ()> {
        self.ffi_lock.write().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub(super) fn ensure_running(&self) -> Result<(), EngineError> {
        if self.shutdown_flag.load(Ordering::SeqCst) {
            return Err(EngineError::NotRunning);
        }
        Ok(())
    }
}

mod commands;
mod lifecycle;
mod wire;

mod events;

#[cfg(test)]
mod tests;
