use std::collections::VecDeque;
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Condvar, Mutex};

use super::super::ffi;

// ---------------------------------------------------------------------------
// Shared state: the only channel between callers, the update callback and the
// render thread.
// ---------------------------------------------------------------------------

/// Work handed to the render thread (it owns all GL access, so resize and
/// readback are requests, never direct calls from other threads).
pub(super) enum Request {
    Resize { width: u32, height: u32 },
    Sample { reply: mpsc::Sender<Result<PixelSample, String>> },
    /// New client-area rect for the composition surface (physical px, relative
    /// to the main window's client area). Applied on the render thread.
    SetRect { x: i32, y: i32, w: u32, h: u32 },
    /// Show/hide the composition content (`SetContent(surface | null)`).
    SetVisible { visible: bool },
    /// Retarget the composition presentation to a different HWND (pip <-> main).
    /// Replaces the whole present pipeline on the render thread; replies with
    /// success/failure for an acknowledged switch. A queued request is never
    /// cancelled: a caller that timed out may enqueue a compensating retarget
    /// behind it, and an undeliverable reply is ignored by the render thread.
    Retarget { hwnd: usize, reply: mpsc::Sender<Result<(), String>> },
}

/// One frame read back from the FBO by the render thread (RGBA8; GL row
/// order, so row 0 is the bottom row as `glReadPixels` returns it).
#[allow(dead_code)] // read by the render tests; the GPU path never reads back
pub(crate) struct PixelSample {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) pixels: Vec<u8>,
}

pub(super) struct SharedInner {
    pub(super) pending: VecDeque<Request>,
    /// Update callbacks observed (monotonic; ENGINE-003 evidence).
    pub(super) notifications: u64,
    /// Notifications already serviced by an `mpv_render_context_update()`
    /// call. `notifications > serviced` = an update is due.
    pub(super) serviced: u64,
    pub(super) ready: bool,
    pub(super) init_error: Option<String>,
    pub(super) stop: bool,
    /// Last surface size the composition pipeline recreated to (physical px).
    pub(super) present_surface_size: Option<(u32, u32)>,
    /// DPI scale the last rect was converted with (`GetDpiForWindow/96`).
    pub(super) present_scale: Option<f32>,
    /// The visual's logical rect in DIP (x, y, w, h) as presented.
    pub(super) present_visual_rect_dip: Option<(f32, f32, f32, f32)>,
}

pub(super) struct SharedState {
    pub(super) inner: Mutex<SharedInner>,
    /// Notified by the update callback, request enqueues and shutdown. The
    /// callback holds `inner` while notifying, so no wakeup can be lost.
    pub(super) wake: Condvar,
    /// Rendered frame count (lock-free reads for the tests/pollers).
    pub(super) frames: AtomicU64,
    /// Frames handed to DirectComposition (GPU-presented count).
    pub(super) presented: AtomicU64,
    /// Whether the one-shot `FIRST_FRAME_EVENT` has already been emitted for
    /// the current media load. Armed (false) at construction — i.e. per surface
    /// (re)creation — and re-armed by `rearm_first_frame` on every `loadfile`.
    pub(super) first_frame_emitted: AtomicBool,
    /// True once the render thread has fully torn down (context freed, GL
    /// released, window destroyed).
    pub(super) finished: AtomicBool,
}

impl SharedState {
    pub(super) fn new() -> Self {
        Self {
            inner: Mutex::new(SharedInner {
                pending: VecDeque::new(),
                notifications: 0,
                serviced: 0,
                ready: false,
                init_error: None,
                stop: false,
                present_surface_size: None,
                present_scale: None,
                present_visual_rect_dip: None,
            }),
            wake: Condvar::new(),
            frames: AtomicU64::new(0),
            presented: AtomicU64::new(0),
            first_frame_emitted: AtomicBool::new(false),
            finished: AtomicBool::new(false),
        }
    }

    pub(super) fn lock(&self) -> std::sync::MutexGuard<'_, SharedInner> {
        self.inner.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Consume the one-shot `FIRST_FRAME_EVENT` signal. `true` exactly once
    /// per armed period — i.e. on the first successful present after a
    /// (re)creation or a `rearm_first_frame`. The `swap` is the whole guard: the
    /// render thread is the only caller, so a frame can never be signalled
    /// twice, and the signal can never be lost while a frame is presented.
    pub(super) fn take_first_frame_signal(&self) -> bool {
        !self.first_frame_emitted.swap(true, Ordering::SeqCst)
    }
}

/// `mpv_render_update_fn` (render.h). Contract: no mpv API, no rendering, no
/// blocking — this body locks the shared state, bumps a counter and notifies
/// the condvar, nothing else.
pub(super) unsafe extern "C" fn on_render_update(callback_ctx: *mut c_void) {
    if callback_ctx.is_null() {
        return;
    }
    // SAFETY: engine teardown order guarantees the `SharedState` behind this
    // pointer outlives every callback: the render thread frees the render
    // context (after which no callback can fire) while still holding its Arc.
    let shared = &*(callback_ctx as *const SharedState);
    {
        let mut inner = shared.lock();
        inner.notifications = inner.notifications.saturating_add(1);
    }
    shared.wake.notify_all();
}

/// Borrowed `mpv_handle*` made sendable for the render thread. Only that
/// thread passes it to `mpv_render_context_create`; the handle outlives the
/// render context by construction (engine teardown order).
#[derive(Clone, Copy)]
pub(crate) struct RenderHost(pub(crate) *mut ffi::MpvHandle);

unsafe impl Send for RenderHost {}
