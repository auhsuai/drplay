//! S2 render core: owns the render thread, the hidden-anchor WGL context
//! (render/gl.rs) and the `mpv_render_context`. Headless by design: frames
//! render into an internal FBO; nothing is presented (S3 adds the
//! D3D11/DComp interop that puts the frame on screen).
//!
//! Threading contract (render.h "Threading" + ADR "Threading Model"):
//! - every `mpv_render_*` call happens on THIS module's render thread, and
//!   that thread calls no other libmpv API;
//! - the update callback only locks + notifies a condvar: no mpv call, no GL
//!   call, no rendering, no blocking work;
//! - teardown order (spec §18): stop flag + notify -> join render thread (it
//!   frees the render context with the GL context current, deletes the GL
//!   objects, then drops WGL/DC/window) -> only then may `mpv_destroy` run.
//!   `engine.rs` runs `RenderSurface::shutdown` from a teardown hook, so this
//!   ordering holds by construction.

mod composition;
mod gl;
mod interop;

#[cfg(test)]
mod tests;

use std::collections::VecDeque;
use std::ffi::{c_char, c_int, c_void, CStr};
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use super::engine::EngineError;
use super::ffi;
use composition::Composition;
use gl::GlContext;
use interop::{InteropApi, InteropDevice, InteropObject};

/// Name of the render thread (observable via `GetThreadDescription`; the
/// integration tests assert the thread lifecycle with it, like S1 does for
/// the event thread).
pub(crate) const RENDER_THREAD_NAME: &str = "libmpv-render";

/// Initial FBO/texture size. The first real resize arrives from the surface
/// rect pipeline in S3; until then this is the headless target size.
pub(crate) const RENDER_INITIAL_WIDTH: u32 = 1280;
pub(crate) const RENDER_INITIAL_HEIGHT: u32 = 720;

/// Bound for the render context to become ready during engine setup.
pub(crate) const RENDER_READY_TIMEOUT: Duration = Duration::from_secs(5);

/// Bound for the render thread to observe the stop flag and exit. The notify
/// runs first, so this is a pathological-case guard, not a wait.
pub(crate) const RENDER_JOIN_TIMEOUT: Duration = Duration::from_secs(2);

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

/// Poll interval while waiting for the render context to come up.
const RENDER_READY_POLL: Duration = Duration::from_millis(10);

// ---------------------------------------------------------------------------
// mpv render API FFI (render.h + render_gl.h; hand-rolled, like ffi.rs)
// ---------------------------------------------------------------------------

/// Opaque `mpv_render_context*` (render.h).
#[repr(C)]
pub(crate) struct MpvRenderContext {
    _opaque: [u8; 0],
}

/// `mpv_render_update_fn`: `void (*)(void *cb_ctx)`.
type MpvRenderUpdateFn = unsafe extern "C" fn(*mut c_void);

/// `mpv_render_param` (render.h): `{ enum type; void *data; }` with a
/// zero-type terminator. Pinned by a layout test below.
#[repr(C)]
pub(crate) struct MpvRenderParam {
    param_type: c_int,
    data: *mut c_void,
}

const MPV_RENDER_PARAM_API_TYPE: c_int = 1;
const MPV_RENDER_PARAM_OPENGL_INIT_PARAMS: c_int = 2;
const MPV_RENDER_PARAM_OPENGL_FBO: c_int = 3;
const MPV_RENDER_PARAM_FLIP_Y: c_int = 4;
const MPV_RENDER_PARAM_ADVANCED_CONTROL: c_int = 10;
/// render.h revision e76a35ec95: `Type: int*: 0 for rendering (default),
/// 1 for skipping`. A skipped frame still counts as rendered and still needs
/// `report_swap`, so video timing keeps running while the content is hidden.
const MPV_RENDER_PARAM_SKIP_RENDERING: c_int = 13;

/// `enum mpv_render_update_flag`: a new frame must be rendered.
const MPV_RENDER_UPDATE_FRAME: u64 = 1 << 0;

/// `mpv_opengl_init_params` (render_gl.h).
#[repr(C)]
pub(crate) struct MpvOpenglInitParams {
    get_proc_address: unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_void,
    get_proc_address_ctx: *mut c_void,
}

/// `mpv_opengl_fbo` (render_gl.h).
#[repr(C)]
pub(crate) struct MpvOpenglFbo {
    fbo: c_int,
    w: c_int,
    h: c_int,
    internal_format: c_int,
}

/// The `mpv_render_*` symbols of one loaded libmpv DLL. Loaded separately
/// from `ffi::Api` (same DLL, refcounted) so this slice touches no S1 file
/// outside engine.rs.
struct RenderApi {
    create: unsafe extern "C" fn(
        *mut *mut MpvRenderContext,
        *mut ffi::MpvHandle,
        *mut MpvRenderParam,
    ) -> c_int,
    set_update_callback:
        unsafe extern "C" fn(*mut MpvRenderContext, Option<MpvRenderUpdateFn>, *mut c_void),
    update: unsafe extern "C" fn(*mut MpvRenderContext) -> u64,
    render: unsafe extern "C" fn(*mut MpvRenderContext, *mut MpvRenderParam) -> c_int,
    report_swap: unsafe extern "C" fn(*mut MpvRenderContext),
    free: unsafe extern "C" fn(*mut MpvRenderContext),
    error_string: unsafe extern "C" fn(c_int) -> *const c_char,
    /// Owning loader handle; dropped last so the pointers above stay valid.
    #[allow(dead_code)]
    _library: libloading::Library,
}

impl RenderApi {
    /// Load the DLL (already mapped by the engine's own `ffi::Api`; this only
    /// bumps the module refcount) and resolve the render symbols. Failures
    /// name the exact symbol.
    fn load(path: &Path) -> Result<Self, EngineError> {
        // SAFETY: `Library::new` just maps the DLL image; every symbol is
        // signature-checked against the vendored render.h below.
        let library = unsafe { libloading::Library::new(path) }.map_err(|load_error| {
            EngineError::Load { path: path.to_path_buf(), message: load_error.to_string() }
        })?;
        macro_rules! resolve {
            ($name:literal, $type:ty) => {
                *unsafe { library.get::<$type>(concat!($name, "\0").as_bytes()) }.map_err(
                    |symbol_error| EngineError::Symbol {
                        name: $name.to_string(),
                        message: symbol_error.to_string(),
                    },
                )?
            };
        }
        Ok(RenderApi {
            create: resolve!(
                "mpv_render_context_create",
                unsafe extern "C" fn(
                    *mut *mut MpvRenderContext,
                    *mut ffi::MpvHandle,
                    *mut MpvRenderParam,
                ) -> c_int
            ),
            set_update_callback: resolve!(
                "mpv_render_context_set_update_callback",
                unsafe extern "C" fn(
                    *mut MpvRenderContext,
                    Option<MpvRenderUpdateFn>,
                    *mut c_void
                )
            ),
            update: resolve!(
                "mpv_render_context_update",
                unsafe extern "C" fn(*mut MpvRenderContext) -> u64
            ),
            render: resolve!(
                "mpv_render_context_render",
                unsafe extern "C" fn(*mut MpvRenderContext, *mut MpvRenderParam) -> c_int
            ),
            report_swap: resolve!(
                "mpv_render_context_report_swap",
                unsafe extern "C" fn(*mut MpvRenderContext)
            ),
            free: resolve!(
                "mpv_render_context_free",
                unsafe extern "C" fn(*mut MpvRenderContext)
            ),
            error_string: resolve!(
                "mpv_error_string",
                unsafe extern "C" fn(c_int) -> *const c_char
            ),
            _library: library,
        })
    }
}

fn error_message(api: &RenderApi, code: c_int) -> String {
    // SAFETY: plain extern getter; the returned string is static.
    let pointer = unsafe { (api.error_string)(code) };
    if pointer.is_null() {
        return format!("unknown error {code}");
    }
    unsafe { CStr::from_ptr(pointer) }.to_string_lossy().into_owned()
}

// ---------------------------------------------------------------------------
// Shared state: the only channel between callers, the update callback and the
// render thread.
// ---------------------------------------------------------------------------

/// Work handed to the render thread (it owns all GL access, so resize and
/// readback are requests, never direct calls from other threads).
enum Request {
    Resize { width: u32, height: u32 },
    Sample { reply: mpsc::Sender<Result<PixelSample, String>> },
    /// New client-area rect for the composition surface (physical px, relative
    /// to the main window's client area). Applied on the render thread.
    SetRect { x: i32, y: i32, w: u32, h: u32 },
    /// Show/hide the composition content (`SetContent(surface | null)`).
    SetVisible { visible: bool },
}

/// One frame read back from the FBO by the render thread (RGBA8; GL row
/// order, so row 0 is the bottom row as `glReadPixels` returns it).
#[allow(dead_code)] // read by the render tests; the GPU path never reads back
pub(crate) struct PixelSample {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) pixels: Vec<u8>,
}

struct SharedInner {
    pending: VecDeque<Request>,
    /// Update callbacks observed (monotonic; ENGINE-003 evidence).
    notifications: u64,
    /// Notifications already serviced by an `mpv_render_context_update()`
    /// call. `notifications > serviced` = an update is due.
    serviced: u64,
    ready: bool,
    init_error: Option<String>,
    stop: bool,
    /// Last surface size the composition pipeline recreated to (physical px).
    present_surface_size: Option<(u32, u32)>,
    /// DPI scale the last rect was converted with (`GetDpiForWindow/96`).
    present_scale: Option<f32>,
    /// The visual's logical rect in DIP (x, y, w, h) as presented.
    present_visual_rect_dip: Option<(f32, f32, f32, f32)>,
}

struct SharedState {
    inner: Mutex<SharedInner>,
    /// Notified by the update callback, request enqueues and shutdown. The
    /// callback holds `inner` while notifying, so no wakeup can be lost.
    wake: Condvar,
    /// Rendered frame count (lock-free reads for the tests/pollers).
    frames: AtomicU64,
    /// Frames handed to DirectComposition (GPU-presented count).
    presented: AtomicU64,
    /// Whether the one-shot [`FIRST_FRAME_EVENT`] has already been emitted for
    /// the current media load. Armed (false) at construction — i.e. per surface
    /// (re)creation — and re-armed by `rearm_first_frame` on every `loadfile`.
    first_frame_emitted: AtomicBool,
    /// True once the render thread has fully torn down (context freed, GL
    /// released, window destroyed).
    finished: AtomicBool,
}

impl SharedState {
    fn new() -> Self {
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

    fn lock(&self) -> std::sync::MutexGuard<'_, SharedInner> {
        self.inner.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Consume the one-shot [`FIRST_FRAME_EVENT`] signal. `true` exactly once
    /// per armed period — i.e. on the first successful present after a
    /// (re)creation or a `rearm_first_frame`. The `swap` is the whole guard: the
    /// render thread is the only caller, so a frame can never be signalled
    /// twice, and the signal can never be lost while a frame is presented.
    fn take_first_frame_signal(&self) -> bool {
        !self.first_frame_emitted.swap(true, Ordering::SeqCst)
    }
}

/// `mpv_render_update_fn` (render.h). Contract: no mpv API, no rendering, no
/// blocking — this body locks the shared state, bumps a counter and notifies
/// the condvar, nothing else.
unsafe extern "C" fn on_render_update(callback_ctx: *mut c_void) {
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

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/// The S3 presentation pipeline: interop registration (GL texture <-> D3D11
/// texture), the interop device and the D3D11/DirectComposition stack. All
/// four live on the render thread.
///
/// Field order is load-bearing for teardown: the interop object is
/// unregistered first (while the GL context is still current and the device
/// handle alive), then the device closes, then the composition releases its
/// D3D/DComp objects. The GL context itself is dropped after all of this
/// (RenderThreadState field order).
struct PresentPipeline {
    object: Option<InteropObject>,
    device: InteropDevice,
    composition: Composition,
}

impl PresentPipeline {
    /// Create the composition stack + open the interop device + register the
    /// GL FBO texture against a fresh D3D11 texture. Any failure fails engine
    /// creation (typed error up the chain; no silent fallback).
    fn new(
        hwnd: usize,
        gl: &GlContext,
        width: u32,
        height: u32,
    ) -> Result<Self, String> {
        let mut composition =
            Composition::create(hwnd, width, height).map_err(|e| e.to_string())?;
        let api = InteropApi::load().map_err(|e| e.to_string())?;
        let device =
            InteropDevice::open(api, composition.device_raw()).map_err(|e| e.to_string())?;
        composition
            .replace_interop_texture(width, height)
            .map_err(|e| e.to_string())?;
        let object = device
            .register(gl.texture(), composition.interop_texture_raw())
            .map_err(|e| e.to_string())?;
        log::info!("[player] interop registered (GL texture {}, {width}x{height})", gl.texture());
        Ok(Self {
            object: Some(object),
            device,
            composition,
        })
    }

    /// A frame may be presented only with a registered interop object, a
    /// visible content and a non-collapsed rect.
    fn can_present(&self) -> bool {
        let (_, _, w, h) = self.composition.rect();
        w > 0
            && h > 0
            && self.composition.visible()
            && self.object.as_ref().map(InteropObject::is_registered).unwrap_or(false)
    }

    fn lock(&self) -> Result<(), String> {
        match self.object.as_ref() {
            Some(object) => {
                object.lock().map_err(|e| e.to_string())?;
                Ok(())
            }
            None => Err("interop object is not registered".to_string()),
        }
    }

    fn unlock(&self) -> Result<(), String> {
        match self.object.as_ref() {
            Some(object) => {
                object.unlock().map_err(|e| e.to_string())?;
                Ok(())
            }
            None => Err("interop object is not registered".to_string()),
        }
    }

    /// Unregister -> reallocate the GL FBO storage -> new D3D texture ->
    /// re-register. The unregister MUST come first: `glTexImage2D` replaces
    /// the storage of the registered texture object. The DComp surface is
    /// recreated by the following `set_rect` (size change detected there).
    fn refresh_size(
        &mut self,
        gl: &mut GlContext,
        width: u32,
        height: u32,
    ) -> Result<(), String> {
        if let Some(object) = self.object.as_mut() {
            object.unregister();
        }
        gl.resize(width, height)?;
        // The old D3D texture is released here, after the unregister above.
        self.composition
            .replace_interop_texture(width, height)
            .map_err(|e| e.to_string())?;
        let object = self
            .device
            .register(gl.texture(), self.composition.interop_texture_raw())
            .map_err(|e| e.to_string())?;
        self.object = Some(object);
        Ok(())
    }

    fn set_rect(&mut self, x: i32, y: i32, w: u32, h: u32) -> Result<(), String> {
        self.composition.set_rect(x, y, w, h).map_err(|e| e.to_string())
    }

    fn set_visible(&mut self, visible: bool) -> Result<(), String> {
        self.composition.set_visible(visible).map_err(|e| e.to_string())
    }

    fn present(&self) -> Result<(), String> {
        self.composition.present().map_err(|e| e.to_string())
    }
}

/// Outcome of one update cycle: `rendered` = mpv produced a frame (even a
/// skipped one), `presented` = that frame reached DirectComposition.
#[derive(Clone, Copy, Default)]
struct PumpOutcome {
    rendered: bool,
    presented: bool,
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

    /// Re-arm the one-shot [`FIRST_FRAME_EVENT`]: the next successful present
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

fn join_thread(thread: JoinHandle<()>, timeout: Duration) -> Result<(), EngineError> {
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
fn render_thread_main(
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

#[cfg(test)]
mod layout {
    use super::*;
    use std::mem::{align_of, offset_of, size_of};

    /// Pins the Rust declarations to the C ABI of render.h/render_gl.h
    /// (x86_64, MSVC: enums are 4-byte ints, pointers 8). A drift here would
    /// corrupt every render API call silently.
    #[test]
    fn render_ffi_layouts_match_the_shipped_headers() {
        // mpv_render_param: type(4 + pad) data(8)
        assert_eq!(size_of::<MpvRenderParam>(), 16);
        assert_eq!(align_of::<MpvRenderParam>(), 8);
        assert_eq!(offset_of!(MpvRenderParam, data), 8);

        // mpv_opengl_init_params: fn pointer(8) ctx(8)
        assert_eq!(size_of::<MpvOpenglInitParams>(), 16);

        // mpv_opengl_fbo: 4 ints
        assert_eq!(size_of::<MpvOpenglFbo>(), 16);
        assert_eq!(offset_of!(MpvOpenglFbo, internal_format), 12);
    }
}
