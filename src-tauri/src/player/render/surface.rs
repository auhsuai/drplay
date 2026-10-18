use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use super::super::engine::EngineError;
use super::gl;
use super::shared::{PixelSample, RenderHost, Request, SharedState};
use super::thread::{join_thread, render_thread_main};

/// Name of the render thread (observable via `GetThreadDescription`; the
/// integration tests assert the thread lifecycle with it, like S1 does for
/// the event thread).
pub(crate) const RENDER_THREAD_NAME: &str = "libmpv-render";

/// Bound for the render thread to observe the stop flag and exit. The notify
/// runs first, so this is a pathological-case guard, not a wait.
pub(crate) const RENDER_JOIN_TIMEOUT: Duration = Duration::from_secs(2);

/// Poll interval while waiting for the render context to come up.
const RENDER_READY_POLL: Duration = Duration::from_millis(10);

/// Handle to the render thread and its state. Cheap to clone via `Arc`; the
/// GL context itself never leaves the thread.
pub(crate) struct RenderSurface {
    shared: Arc<SharedState>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl RenderSurface {
    /// Spawn the render thread. `hwnd` = the main window the composition
    /// target is bound to (`None` = S2 headless render, tests only).
    /// `Err` = the thread could not start (the mpv handle then has no render
    /// context attached and may be destroyed).
    pub(crate) fn spawn(
        host: RenderHost,
        dll_path: PathBuf,
        width: u32,
        height: u32,
        hwnd: Option<usize>,
    ) -> Result<Arc<Self>, EngineError> {
        let shared = Arc::new(SharedState::new());
        let surface =
            Arc::new(RenderSurface { shared: Arc::clone(&shared), thread: Mutex::new(None) });
        let thread = {
            let shared = Arc::clone(&shared);
            thread::Builder::new()
                .name(RENDER_THREAD_NAME.to_string())
                .spawn(move || {
                    render_thread_main(host, dll_path, width, height, hwnd, shared)
                })
                .map_err(|spawn_error| EngineError::Render {
                    message: format!("cannot spawn the render thread: {spawn_error}"),
                })?
        };
        *surface.thread.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(thread);
        Ok(surface)
    }

    /// Wait (bounded) for the render context to be created and the update
    /// callback installed. `Err` = setup failed. The caller must still call
    /// `shutdown` before destroying the mpv handle (the thread may be stuck
    /// in driver initialization; spec §18).
    pub(crate) fn wait_ready(&self, timeout: Duration) -> Result<(), EngineError> {
        let deadline = Instant::now() + timeout;
        loop {
            {
                let inner = self.shared.lock();
                if inner.ready {
                    return Ok(());
                }
                if let Some(message) = &inner.init_error {
                    return Err(EngineError::Render { message: message.clone() });
                }
            }
            if Instant::now() >= deadline {
                return Err(EngineError::Render {
                    message: format!(
                        "render context not ready within {timeout:?} (the render thread may be stuck in driver initialization)"
                    ),
                });
            }
            thread::sleep(RENDER_READY_POLL);
        }
    }

    /// True while the render thread owns a live render context.
    #[allow(dead_code)] // read-only diagnostic accessor (engine render_ready)
    pub(crate) fn is_ready(&self) -> bool {
        !self.shared.finished.load(Ordering::SeqCst) && self.shared.lock().ready
    }

    /// Frames rendered into the FBO so far.
    #[allow(dead_code)] // read-only diagnostic accessor (ENGINE-004)
    pub(crate) fn frame_count(&self) -> u64 {
        self.shared.frames.load(Ordering::SeqCst)
    }

    /// Update callbacks observed so far (ENGINE-003 evidence).
    #[allow(dead_code)] // read-only diagnostic accessor (ENGINE-003)
    pub(crate) fn update_notifications(&self) -> u64 {
        self.shared.lock().notifications
    }

    /// Ask the render thread for the next size (applied before the next
    /// render). Never touches GL from the caller's thread.
    #[allow(dead_code)] // S3 wires this to the surface rect; the resize test drives it today
    pub(crate) fn resize(&self, width: u32, height: u32) -> Result<(), EngineError> {
        // Validated here as well as on the render thread: the caller gets a
        // typed error immediately instead of a logged thread-side failure.
        if width == 0
            || height == 0
            || width > gl::MAX_TEXTURE_DIMENSION
            || height > gl::MAX_TEXTURE_DIMENSION
        {
            return Err(EngineError::Render {
                message: format!("invalid render surface size {width}x{height}"),
            });
        }
        {
            let mut inner = self.shared.lock();
            inner.pending.push_back(Request::Resize { width, height });
        }
        self.shared.wake.notify_all();
        Ok(())
    }

    /// S3: request a new client-area rect (physical px) for the composition
    /// surface. The render thread applies it on its next wakeup: resize of the
    /// GL FBO + interop registration + DComp surface when the size changed,
    /// visual offsets (DIP) always.
    pub(crate) fn set_rect(&self, x: i32, y: i32, w: u32, h: u32) -> Result<(), EngineError> {
        if w > gl::MAX_TEXTURE_DIMENSION || h > gl::MAX_TEXTURE_DIMENSION {
            return Err(EngineError::Render {
                message: format!("invalid surface rect {w}x{h}"),
            });
        }
        {
            let mut inner = self.shared.lock();
            inner.pending.push_back(Request::SetRect { x, y, w, h });
        }
        self.shared.wake.notify_all();
        Ok(())
    }

    /// S3: show/hide the composition content. `SetContent(null)` while hidden.
    pub(crate) fn set_visible(&self, visible: bool) -> Result<(), EngineError> {
        {
            let mut inner = self.shared.lock();
            inner.pending.push_back(Request::SetVisible { visible });
        }
        self.shared.wake.notify_all();
        Ok(())
    }

    /// Frames handed to DirectComposition so far.
    #[allow(dead_code)] // read-only diagnostic accessor (S3 tests)
    pub(crate) fn presented_frame_count(&self) -> u64 {
        self.shared.presented.load(Ordering::SeqCst)
    }

    /// Re-arm the one-shot `FIRST_FRAME_EVENT`: the next successful present
    /// signals the frontend again. Called by `engine.rs` for every `loadfile`,
    /// i.e. per media item, so the frontend's "a frame of THIS item is on screen"
    /// state can never be satisfied by a frame of the previous one.
    ///
    /// Deliberately a lock-free flag write and nothing else: it must not touch
    /// GL, the composition, the render loop or mpv, so it is safe to call from
    /// any thread and costs nothing when a video never starts.
    pub(crate) fn rearm_first_frame(&self) {
        self.shared.first_frame_emitted.store(false, Ordering::SeqCst);
    }

    /// Whether the one-shot first-frame signal has already gone out for the
    /// current media load. Read by the render tests and by the read-only
    /// `video_host_first_frame_presented` pull (player/mod.rs), through which
    /// the frontend can recover a signal whose event it missed.
    pub(crate) fn first_frame_emitted(&self) -> bool {
        self.shared.first_frame_emitted.load(Ordering::SeqCst)
    }

    /// Test-only stand-in for the render thread's first successful present: runs
    /// the real one-shot transition without needing a GPU, a window or media.
    #[cfg(test)]
    pub(crate) fn mark_first_frame_emitted(&self) -> bool {
        self.shared.take_first_frame_signal()
    }

    /// Last surface size the composition pipeline recreated to (physical px).
    #[allow(dead_code)] // read-only diagnostic accessor (S3 tests)
    pub(crate) fn present_surface_size(&self) -> Option<(u32, u32)> {
        self.shared.lock().present_surface_size
    }

    /// The DPI scale the last rect was converted with (`GetDpiForWindow/96`).
    #[allow(dead_code)] // read-only diagnostic accessor (S3 tests)
    pub(crate) fn present_scale(&self) -> Option<f32> {
        self.shared.lock().present_scale
    }

/// The visual's logical rect in DIP (x, y, w, h) as presented last.
    #[allow(dead_code)] // S3 tests (render/tests.rs)
    pub(crate) fn last_visual_rect_dip(&self) -> Option<(f32, f32, f32, f32)> {
        self.shared.lock().present_visual_rect_dip
    }

    /// Read the FBO back from the render thread (test helper). Runs
    /// `glReadPixels` on the render thread between two of its renders.
    #[allow(dead_code)] // test/diagnostic today; the S3 interop reads via the GPU path
    pub(crate) fn sample_pixels(&self, timeout: Duration) -> Result<PixelSample, EngineError> {
        let (reply, receiver) = mpsc::channel();
        {
            let mut inner = self.shared.lock();
            inner.pending.push_back(Request::Sample { reply });
        }
        self.shared.wake.notify_all();
        match receiver.recv_timeout(timeout) {
            Ok(Ok(sample)) => Ok(sample),
            Ok(Err(message)) => Err(EngineError::Render { message }),
            Err(_) => Err(EngineError::Render {
                message: format!("the FBO readback did not complete within {timeout:?}"),
            }),
        }
    }

    /// Stop + join the render thread; it frees the render context, the GL
    /// objects, WGL/DC and the anchor window on the way out. Idempotent. On a
    /// join timeout every handle is intentionally left alive — the caller
    /// must then abort teardown before `mpv_destroy` (spec §18).
    pub(crate) fn shutdown(&self) -> Result<(), EngineError> {
        {
            let mut inner = self.shared.lock();
            inner.stop = true;
        }
        self.shared.wake.notify_all();
        let thread = self.thread.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
        let Some(thread) = thread else {
            return Ok(()); // already shut down (or never started)
        };
        join_thread(thread, RENDER_JOIN_TIMEOUT)
    }
}
