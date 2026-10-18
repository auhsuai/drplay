use std::ffi::{c_char, c_int, c_void, CStr};
use std::path::Path;

use super::super::engine::EngineError;
use super::super::ffi;

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
    pub(super) param_type: c_int,
    pub(super) data: *mut c_void,
}

pub(super) const MPV_RENDER_PARAM_API_TYPE: c_int = 1;
pub(super) const MPV_RENDER_PARAM_OPENGL_INIT_PARAMS: c_int = 2;
pub(super) const MPV_RENDER_PARAM_OPENGL_FBO: c_int = 3;
pub(super) const MPV_RENDER_PARAM_FLIP_Y: c_int = 4;
pub(super) const MPV_RENDER_PARAM_ADVANCED_CONTROL: c_int = 10;
/// render.h revision e76a35ec95: `Type: int*: 0 for rendering (default),
/// 1 for skipping`. A skipped frame still counts as rendered and still needs
/// `report_swap`, so video timing keeps running while the content is hidden.
pub(super) const MPV_RENDER_PARAM_SKIP_RENDERING: c_int = 13;

/// `enum mpv_render_update_flag`: a new frame must be rendered.
pub(super) const MPV_RENDER_UPDATE_FRAME: u64 = 1 << 0;

/// `mpv_opengl_init_params` (render_gl.h).
#[repr(C)]
pub(crate) struct MpvOpenglInitParams {
    pub(super) get_proc_address: unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_void,
    pub(super) get_proc_address_ctx: *mut c_void,
}

/// `mpv_opengl_fbo` (render_gl.h).
#[repr(C)]
pub(crate) struct MpvOpenglFbo {
    pub(super) fbo: c_int,
    pub(super) w: c_int,
    pub(super) h: c_int,
    pub(super) internal_format: c_int,
}

/// The `mpv_render_*` symbols of one loaded libmpv DLL. Loaded separately
/// from `ffi::Api` (same DLL, refcounted) so this slice touches no S1 file
/// outside engine.rs.
pub(super) struct RenderApi {
    pub(super) create: unsafe extern "C" fn(
        *mut *mut MpvRenderContext,
        *mut ffi::MpvHandle,
        *mut MpvRenderParam,
    ) -> c_int,
    pub(super) set_update_callback:
        unsafe extern "C" fn(*mut MpvRenderContext, Option<MpvRenderUpdateFn>, *mut c_void),
    pub(super) update: unsafe extern "C" fn(*mut MpvRenderContext) -> u64,
    pub(super) render: unsafe extern "C" fn(*mut MpvRenderContext, *mut MpvRenderParam) -> c_int,
    pub(super) report_swap: unsafe extern "C" fn(*mut MpvRenderContext),
    pub(super) free: unsafe extern "C" fn(*mut MpvRenderContext),
    pub(super) error_string: unsafe extern "C" fn(c_int) -> *const c_char,
    /// Owning loader handle; dropped last so the pointers above stay valid.
    #[allow(dead_code)]
    _library: libloading::Library,
}

impl RenderApi {
    /// Load the DLL (already mapped by the engine's own `ffi::Api`; this only
    /// bumps the module refcount) and resolve the render symbols. Failures
    /// name the exact symbol.
    pub(super) fn load(path: &Path) -> Result<Self, EngineError> {
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

pub(super) fn error_message(api: &RenderApi, code: c_int) -> String {
    // SAFETY: plain extern getter; the returned string is static.
    let pointer = unsafe { (api.error_string)(code) };
    if pointer.is_null() {
        return format!("unknown error {code}");
    }
    unsafe { CStr::from_ptr(pointer) }.to_string_lossy().into_owned()
}
