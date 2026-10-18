use std::ffi::{c_int, c_void};
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use super::super::engine::EngineError;
use super::api::{
    error_message, MpvOpenglFbo, MpvOpenglInitParams, MpvRenderContext, MpvRenderParam,
    RenderApi, MPV_RENDER_PARAM_ADVANCED_CONTROL, MPV_RENDER_PARAM_API_TYPE,
    MPV_RENDER_PARAM_FLIP_Y, MPV_RENDER_PARAM_OPENGL_FBO,
    MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, MPV_RENDER_PARAM_SKIP_RENDERING,
    MPV_RENDER_UPDATE_FRAME,
};
use super::gl;
use super::gl::GlContext;
use super::pipeline::{PresentPipeline, PumpOutcome};
use super::shared::{on_render_update, PixelSample, RenderHost, Request, SharedState};

/// Idle wait between wakeups. The update callback wakes the thread
/// immediately; the timeout only re-checks the stop flag and doubles as a
/// safety-net `update()` cadence.
const RENDER_WAIT_TIMEOUT: Duration = Duration::from_millis(250);

/// Frontend event: "the render thread has handed its first frame of the current
/// media load to DirectComposition". ONE-SHOT per media load (re-armed by
/// `RenderSurface::rearm_first_frame`, which `engine.rs` calls on `loadfile`,
/// and by construction on every surface (re)creation).
///
/// Why the frontend needs it: `shouldShowVideoHost` flips as soon as a track is
/// SELECTED, and the page drops its background over the video rect from that
/// moment. Without a real "a frame is on screen" signal the app cannot tell
/// "track selected, nothing decoded yet" from "video is rendering", and the
/// shell behind the overlay shows through an empty video rect. "the renderer
/// initialised" and "a Present call happened" are NOT that signal — only the
/// presented-frame counter is.
const FIRST_FRAME_EVENT: &str = "video-first-frame";

/// Emit [`FIRST_FRAME_EVENT`] once, best-effort. Never fails the render loop: a
/// missing app handle (very early startup) or a closed webview only costs the
/// signal, never a frame.
fn emit_first_frame() {
    let Some(app) = crate::APP_HANDLE.get() else {
        log::debug!("[player] first-frame signal skipped: the app handle is not initialized");
        return;
    };
    if let Err(emit_error) = tauri::Emitter::emit(app, FIRST_FRAME_EVENT, ()) {
        log::warn!("[player] cannot emit '{FIRST_FRAME_EVENT}': {emit_error}");
    }
}

/// The render thread's state: everything GL and every mpv render API call
/// lives here, and is only ever touched on the render thread.
///
/// Field order is load-bearing: `present` drops BEFORE `gl_context` so the
/// interop unregister and the DComp/D3D release happen while the GL context
/// is still current (spec §18 teardown order).
struct RenderThreadState {
    api: RenderApi,
    present: Option<PresentPipeline>,
    gl_context: GlContext,
    render_ctx: *mut MpvRenderContext,
    /// Set by `apply_set_rect` after a size-driven rebuild left the GL FBO and
    /// the DComp surface with no content. The next pump must run one
    /// render+present even without an `MPV_RENDER_UPDATE_FRAME` flag — that is
    /// the whole point (render.h: "The renderer will reconfigure itself every
    /// time the target surface configuration (such as size) is changed", and
    /// "If no new frame is available, the previous frame is redrawn"). Without
    /// it a resize while paused/buffering never repaints and the video area
    /// stays black until the next frame arrives.
    needs_repaint: bool,
}

impl RenderThreadState {
    fn init(
        host: RenderHost,
        dll_path: &Path,
        width: u32,
        height: u32,
        hwnd: Option<usize>,
    ) -> Result<Self, String> {
        let api = RenderApi::load(dll_path).map_err(|load_error| load_error.to_string())?;
        let gl_context = GlContext::create(width, height)?;
        // The composition pipeline is created here, on the render thread,
        // right after the GL context (wglDXOpenDeviceNV needs it current) and
        // BEFORE the engine is handed out: an unavailable NV_DX_interop2 must
        // fail engine creation, never degrade silently.
        let present = match hwnd {
            Some(raw_hwnd) => Some(PresentPipeline::new(raw_hwnd, &gl_context, width, height)?),
            None => None,
        };
        let mut init_params = MpvOpenglInitParams {
            get_proc_address: gl::gl_get_proc_address,
            get_proc_address_ctx: gl_context.proc_address_ctx(),
        };
        let advanced: c_int = 1;
        let mut params = [
            MpvRenderParam {
                param_type: MPV_RENDER_PARAM_API_TYPE,
                data: c"opengl".as_ptr() as *mut c_void,
            },
            MpvRenderParam {
                param_type: MPV_RENDER_PARAM_OPENGL_INIT_PARAMS,
                data: (&mut init_params as *mut MpvOpenglInitParams).cast(),
            },
            MpvRenderParam {
                param_type: MPV_RENDER_PARAM_ADVANCED_CONTROL,
                data: (&advanced as *const c_int).cast_mut().cast(),
            },
            MpvRenderParam { param_type: 0, data: ptr::null_mut() },
        ];
        let mut render_ctx: *mut MpvRenderContext = ptr::null_mut();
        // SAFETY: the mpv handle is live (the engine keeps it alive until
        // after this thread has stopped); the params array is zero-terminated
        // and every pointed-to value outlives the call; the GL context is
        // current on this thread, as the OpenGL backend requires.
        let code = unsafe { (api.create)(&mut render_ctx, host.0, params.as_mut_ptr()) };
        if code < 0 {
            return Err(format!(
                "mpv_render_context_create failed ({}, code {code})",
                error_message(&api, code)
            ));
        }
        if render_ctx.is_null() {
            return Err("mpv_render_context_create returned success but no context".to_string());
        }
        Ok(RenderThreadState {
            api,
            present,
            gl_context,
            render_ctx,
            needs_repaint: false,
        })
    }

    /// Presentation order mirrors the NV_DX_interop spec's own sample loop:
    /// `lock -> GL renders -> glFlush -> unlock -> D3D copies` (GL may only
    /// touch the registered texture while locked, and the queued GL commands
    /// must be submitted before the hand-off — see the `glFlush` call below).
    /// Hidden/collapsed frames render with
    /// MPV_RENDER_PARAM_SKIP_RENDERING so playback timing keeps running
    /// without touching the texture. A headless engine (no composition
    /// pipeline, S2 tests) always renders normally — skipping there would
    /// leave the FBO black.
    ///
    /// A pending `needs_repaint` also drives the pump without an update flag:
    /// render.h documents that a render call after a target-surface change
    /// reconfigures the renderer and redraws the previous frame even when no
    /// new frame is available, which is exactly what repaints a paused frame
    /// after a resize rebuilt the FBO and the DComp surface.
    fn pump_frames(&mut self) -> PumpOutcome {
        // SAFETY: render context is valid; called on the owning thread with
        // the GL context current.
        let flags = unsafe { (self.api.update)(self.render_ctx) };
        let has_frame = flags & MPV_RENDER_UPDATE_FRAME != 0;
        if !has_frame && !self.needs_repaint {
            return PumpOutcome::default();
        }
        let skip_for_hidden = match self.present.as_ref() {
            None => false, // headless: keep rendering into the FBO (S2 behavior)
            Some(present) => !present.can_present(),
        };
        if skip_for_hidden {
            return match render_frame(&self.api, &self.gl_context, self.render_ctx, true) {
                Ok(()) => PumpOutcome { rendered: true, presented: false },
                Err(message) => {
                    log::error!("[player] {message}");
                    PumpOutcome::default()
                }
            };
        }
        let Some(present) = self.present.as_mut() else {
            // Headless engine: render, nothing to present.
            return match render_frame(&self.api, &self.gl_context, self.render_ctx, false) {
                Ok(()) => PumpOutcome { rendered: true, presented: false },
                Err(message) => {
                    log::error!("[player] {message}");
                    PumpOutcome::default()
                }
            };
        };
        if let Err(lock_error) = present.lock() {
            log::error!(
                "[player] interop lock failed; skipping this frame instead of touching unlocked storage: {lock_error}"
            );
            return match render_frame(&self.api, &self.gl_context, self.render_ctx, true) {
                Ok(()) => PumpOutcome { rendered: true, presented: false },
                Err(message) => {
                    log::error!("[player] {message}");
                    PumpOutcome::default()
                }
            };
        }
        let rendered = render_frame(&self.api, &self.gl_context, self.render_ctx, false);
        // WHY THIS EXACT LINE — do not move it, do not fold it into `unlock`,
        // do not "clean it up" as redundant:
        //
        // mpv's render call only ENQUEUES the drawing commands; nothing has
        // told the GPU to execute them. `present.unlock()` on the next line
        // hands the interop texture to Direct3D, whose
        // `CopySubresourceRegion` runs immediately — and without this flush in
        // between that copy reads the
        // texture before the frame is submitted, so the screen is black. Every
        // measurement taken LATER (the D3D interop readback) is correct,
        // because by then the commands have been submitted. Flushing elsewhere
        // is not a fix: after the unlock is too late (D3D owns the resource
        // and GL may no longer touch it), before the render is before the
        // writes exist.
        //
        // Both preconditions hold by construction on this path: the
        // skip/hidden, headless and lock-failure paths all returned above, so
        // this runs only after a real render into the texture AND only while
        // the interop object is still locked.
        self.gl_context.flush();
        let unlocked = present.unlock();
        match (rendered, unlocked) {
            (Ok(()), Ok(())) => {
                // The repaint attempt reached the present stage. Clear the flag
                // even on a present error: a persistent failure must not turn
                // into a per-tick error log, and the next rebuild/frame will
                // re-arm it. Errors from render/unlock fall through with the
                // flag kept, so the next pump retries immediately.
                self.needs_repaint = false;
                match present.present() {
                    Ok(()) => PumpOutcome { rendered: true, presented: true },
                    Err(present_error) => {
                        log::error!("[player] DComp present failed: {present_error}");
                        PumpOutcome { rendered: true, presented: false }
                    }
                }
            }
            (rendered, unlocked) => {
                let rendered_ok = match rendered {
                    Ok(()) => true,
                    Err(message) => {
                        log::error!("[player] {message}");
                        false
                    }
                };
                if let Err(unlock_error) = unlocked {
                    log::error!("[player] interop unlock failed: {unlock_error}");
                }
                PumpOutcome { rendered: rendered_ok, presented: false }
            }
        }
    }
}

/// One `mpv_render_context_render` call. `skip` = MPV_RENDER_PARAM_SKIP_RENDERING
/// (the FBO target is ignored, the frame still counts and still needs
/// report_swap — render.h). FLIP_Y stays 0: no flip is needed anywhere — mpv
/// already writes the frame top-down into the FBO memory, the same row order
/// D3D11/DirectComposition display (gl.rs # Orientation has the full chain).
fn render_frame(
    api: &RenderApi,
    gl_context: &GlContext,
    render_ctx: *mut MpvRenderContext,
    skip: bool,
) -> Result<(), String> {
    let fbo = MpvOpenglFbo {
        fbo: gl_context.framebuffer(),
        w: gl_context.width() as c_int,
        h: gl_context.height() as c_int,
        internal_format: gl::GL_RGBA8 as c_int,
    };
    let flip_y: c_int = 0;
    let skip_flag: c_int = if skip { 1 } else { 0 };
    let mut params = [
        MpvRenderParam {
            param_type: MPV_RENDER_PARAM_OPENGL_FBO,
            data: (&fbo as *const MpvOpenglFbo).cast_mut().cast(),
        },
        MpvRenderParam {
            param_type: MPV_RENDER_PARAM_FLIP_Y,
            data: (&flip_y as *const c_int).cast_mut().cast(),
        },
        MpvRenderParam {
            param_type: MPV_RENDER_PARAM_SKIP_RENDERING,
            data: (&skip_flag as *const c_int).cast_mut().cast(),
        },
        MpvRenderParam { param_type: 0, data: ptr::null_mut() },
    ];
    // SAFETY: render context valid; params outlive the call; GL current.
    // This call may block up to `video-timing-offset` (default 50ms) to
    // pace frames to the display clock — no lock is held here.
    let code = unsafe { (api.render)(render_ctx, params.as_mut_ptr()) };
    if code < 0 {
        return Err(format!(
            "mpv_render_context_render failed ({}, code {code})",
            error_message(api, code)
        ));
    }
    // SAFETY: paired with the successful render call just above.
    unsafe { (api.report_swap)(render_ctx) };
    Ok(())
}

impl Drop for RenderThreadState {
    fn drop(&mut self) {
        if !self.render_ctx.is_null() {
            // SAFETY: on the render thread with the GL context current; the
            // engine joined this thread (teardown hook) before mpv_destroy, so
            // freeing here cannot race the core's destruction.
            unsafe { (self.api.free)(self.render_ctx) };
            self.render_ctx = ptr::null_mut();
        }
        // The GlContext drop then deletes the GL objects, drops WGL/DC and
        // destroys the anchor window (spec §18 order).
    }
}

pub(super) fn join_thread(thread: JoinHandle<()>, timeout: Duration) -> Result<(), EngineError> {
    let deadline = Instant::now() + timeout;
    while !thread.is_finished() {
        if Instant::now() >= deadline {
            return Err(EngineError::RenderThread {
                message: format!(
                    "did not stop within {timeout:?} after wakeup (handles intentionally kept alive, spec §18)"
                ),
            });
        }
        thread::sleep(Duration::from_millis(10));
    }
    thread.join().map_err(|_panic| EngineError::RenderThread {
        message: "panicked during teardown".to_string(),
    })
}

/// The render thread's whole life: init (GL + mpv render context + update
/// callback + composition pipeline when a window is attached), the
/// wait/update/render/present loop, then spec §18 teardown.
pub(super) fn render_thread_main(
    host: RenderHost,
    dll_path: PathBuf,
    width: u32,
    height: u32,
    hwnd: Option<usize>,
    shared: Arc<SharedState>,
) {
    let mut state = match RenderThreadState::init(host, &dll_path, width, height, hwnd) {
        Ok(state) => state,
        Err(message) => {
            shared.lock().init_error = Some(message);
            shared.wake.notify_all();
            return;
        }
    };
    // ADVANCED_CONTROL requires the callback to be set "soon enough" after
    // create; this is the very next call, on the same thread. The callback
    // may fire immediately — the shared state already exists, and a wakeup
    // landing before the loop starts is preserved by the counters/condvar.
    let callback_ctx = Arc::as_ptr(&shared) as *mut c_void;
    // SAFETY: ctx points at `shared`, alive and untouched until the render
    // context is freed below; the callback only locks + notifies.
    unsafe {
        (state.api.set_update_callback)(state.render_ctx, Some(on_render_update), callback_ctx);
    }
    shared.lock().ready = true;
    shared.wake.notify_all();
    log::info!("[player] render context created ({width}x{height})");

    loop {
        let requests = {
            let mut inner = shared.lock();
            if inner.stop {
                break;
            }
            // Wait only when there is no pending work: a pending request or
            // an unserviced callback means the update/render step below is
            // due right away (timeouts fall through to re-check stop + run
            // the safety-net update).
            if inner.pending.is_empty() && inner.notifications <= inner.serviced {
                let (guard, _timeout) = shared
                    .wake
                    .wait_timeout(inner, RENDER_WAIT_TIMEOUT)
                    .unwrap_or_else(|poison| poison.into_inner());
                inner = guard;
                if inner.stop {
                    break;
                }
            }
            // This upcoming `update()` services every callback observed so
            // far; anything arriving after this point re-arms the loop.
            inner.serviced = inner.notifications;
            inner.pending.drain(..).collect::<Vec<Request>>()
        };

        for request in requests {
            match request {
                Request::Resize { width, height } => {
                    if let Err(message) = state.gl_context.resize(width, height) {
                        log::error!("[player] render resize to {width}x{height} failed: {message}");
                    }
                }
                Request::Sample { reply } => {
                    let width = state.gl_context.width();
                    let height = state.gl_context.height();
                    // With the interop bridge live, GL may only touch the
                    // registered texture while it is locked (NV_DX_interop):
                    // bracket the readback like any other GL access.
                    let lock_result = match state.present.as_ref() {
                        Some(present) => present.lock(),
                        None => Ok(()),
                    };
                    let result = match lock_result {
                        Ok(()) => {
                            let read = state
                                .gl_context
                                .read_pixels()
                                .map(|pixels| PixelSample { width, height, pixels });
                            if let Some(present) = state.present.as_ref() {
                                if let Err(unlock_error) = present.unlock() {
                                    log::warn!("[player] interop unlock after readback failed: {unlock_error}");
                                }
                            }
                            read
                        }
                        Err(lock_error) => Err(lock_error),
                    };
                    let _ = reply.send(result);
                }
                Request::SetRect { x, y, w, h } => {
                    apply_set_rect(&mut state, x, y, w, h, &shared);
                }
                Request::SetVisible { visible } => {
                    apply_set_visible(&mut state, visible);
                }
            }
        }

        // The only mpv API this thread ever calls: mpv_render_* on its own
        // context, with the GL context current (render.h threading rules).
        let outcome = state.pump_frames();
        if outcome.rendered {
            shared.frames.fetch_add(1, Ordering::SeqCst);
        }
        if outcome.presented {
            shared.presented.fetch_add(1, Ordering::SeqCst);
            // One-shot per media load. `swap` is the whole guard: the render
            // thread is the only writer, so no frame is ever signalled twice and
            // a lost signal is impossible unless no frame is presented at all.
            if shared.take_first_frame_signal() {
                log::info!("[player] first frame presented; signalling the frontend");
                emit_first_frame();
            }
        }
    }

    drop(state); // frees render context -> present pipeline -> GL/WGL -> anchor
    shared.finished.store(true, Ordering::SeqCst);
    shared.wake.notify_all();
    log::info!("[player] render thread stopped");
}

/// Whether a frontend rect request requires rebuilding the whole present
/// pipeline (GL FBO storage -> interop texture -> registration -> DComp
/// surface). Pure so the resize/sync contract is unit-tested without a GL or
/// D3D context — the present-time `CopySubresourceRegion` pairs the interop
/// texture with the surface texture, so the two must never drift apart in size.
///
/// A COLLAPSED rect (zero/negative, minimized window or a pre-layout read)
/// never rebuilds: there is no target size to build, and `Composition::set_rect`
/// leaves the surface alone for exactly that case.
pub(crate) fn needs_size_sync(current: (u32, u32), requested: (u32, u32)) -> bool {
    requested.0 > 0 && requested.1 > 0 && current != requested
}

/// Apply a frontend rect request on the render thread: resize the GL FBO +
/// interop registration + DComp surface when the size changed, then the DIP
/// offsets. Mirrors the applied values into the shared state (test/diagnostic
/// readback). A failure logs and leaves the pipeline in its last good state —
/// the rect request is retried by the next frontend update.
fn apply_set_rect(
    state: &mut RenderThreadState,
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    shared: &SharedState,
) {
    let Some(present) = state.present.as_mut() else {
        log::debug!("[player] set_rect {x},{y} {w}x{h}: headless render, nothing to present");
        return;
    };
    if needs_size_sync(present.composition.size(), (w, h)) {
        let from = present.composition.size();
        // Why the early return: a failed rebuild leaves the GL FBO and the
        // interop texture at the OLD size. Applying the rect anyway would
        // recreate the DComp surface at the NEW size, and the next present
        // would copy a frame sized for the OLD geometry into the NEW one —
        // a silently "successful" present that shows stale content. Stopping
        // here keeps
        // the pipeline internally consistent; the next frontend update retries.
        if let Err(message) = present.refresh_size(&mut state.gl_context, w, h) {
            log::error!(
                "[player] composition resize from {from:?} to {w}x{h} failed: {message} (rect not applied; the pipeline keeps its last good size)"
            );
            return;
        }
        // A size-driven rebuild reallocates the GL FBO storage and swaps in a
        // fresh (empty) DComp surface. When no new frame is flowing (paused /
        // buffering), no update flag will ever drive a present, so the next
        // pump must repaint once off the back of the rebuild (render.h: a
        // render call after a target-size change reconfigures the renderer and
        // redraws the previous frame).
        state.needs_repaint = true;
        log::info!("[player][diag] rect size {from:?} -> ({w}, {h}): FBO + interop + DComp surface rebuilt");
    }
    if let Err(message) = present.set_rect(x, y, w, h) {
        log::error!("[player] composition rect {x},{y} {w}x{h} failed: {message}");
    }
    let mut inner = shared.lock();
    inner.present_scale = Some(present.composition.dpi_scale());
    inner.present_surface_size = Some(present.composition.size());
    inner.present_visual_rect_dip = Some(present.composition.visual_rect_dip());
}

/// Apply a visibility request: `SetContent(surface | null)` + commit.
fn apply_set_visible(state: &mut RenderThreadState, visible: bool) {
    let Some(present) = state.present.as_mut() else {
        log::debug!("[player] set_visible({visible}): headless render, nothing to present");
        return;
    };
    if let Err(message) = present.set_visible(visible) {
        log::error!("[player] composition visible={visible} failed: {message}");
    }
}
