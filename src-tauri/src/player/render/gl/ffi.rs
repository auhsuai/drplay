//! Raw Win32/OpenGL declarations used by the GL layer: the statically linked
//! GL 1.1 + WGL surface (two link attributes, opengl32 and gdi32), the
//! `PIXELFORMATDESCRIPTOR` mirror, the GL/anchor constants, and the runtime
//! entry-point loader mpv resolves functions through.
//!
//! Nothing here owns state: every item is a declaration, a constant, or a pure
//! loader helper. The six items consumed outside the `gl` module tree are
//! `pub(crate)` because `gl.rs` re-exports them as the module facade; the rest
//! is `pub(super)` so only `gl` and its children (fbo) see them.

use std::ffi::{c_char, c_int, c_void, CStr};
use std::ptr;

use windows_sys::Win32::Foundation::{GetLastError, HMODULE};
use windows_sys::Win32::Graphics::Gdi::HDC;
use windows_sys::Win32::System::LibraryLoader::GetProcAddress;

/// Window class for the anchor. Registered once per process; a second
/// registration legitimately fails with `ERROR_CLASS_ALREADY_EXISTS`.
pub(super) const ANCHOR_CLASS_NAME: &str = "DrPlayRenderAnchor";

/// The anchor is 1x1 and hidden: it is never shown and never sized.
pub(super) const ANCHOR_SIZE: i32 = 1;

/// Upper bound for the surface/FBO dimension accepted from callers. 4K is
/// 3840 wide; every driver we target reports `GL_MAX_TEXTURE_SIZE` >= 16384,
/// so this bound is the app's own sanity check, not the driver's.
pub(crate) const MAX_TEXTURE_DIMENSION: u32 = 16384;

/// RGBA8: the texture internal format (and `mpv_opengl_fbo.internal_format`).
pub(crate) const GL_RGBA8: u32 = 0x8058;
/// `GL_TEXTURE_2D`: the object type the interop bridge registers.
pub(crate) const GL_TEXTURE_2D: u32 = 0x0DE1;
pub(super) const GL_RGBA: u32 = 0x1908;
pub(super) const GL_UNSIGNED_BYTE: u32 = 0x1401;
pub(super) const GL_TEXTURE_MIN_FILTER: u32 = 0x2801;
pub(super) const GL_TEXTURE_MAG_FILTER: u32 = 0x2800;
pub(super) const GL_LINEAR: c_int = 0x2601;
pub(super) const GL_TEXTURE_WRAP_S: u32 = 0x2802;
pub(super) const GL_TEXTURE_WRAP_T: u32 = 0x2803;
pub(super) const GL_CLAMP_TO_EDGE: c_int = 0x812F;
pub(super) const GL_FRAMEBUFFER: u32 = 0x8D40;
pub(super) const GL_COLOR_ATTACHMENT0: u32 = 0x8CE0;
pub(super) const GL_FRAMEBUFFER_COMPLETE: u32 = 0x8CD5;
pub(super) const GL_COLOR_BUFFER_BIT: u32 = 0x0000_4000;
pub(super) const GL_NO_ERROR: u32 = 0;

pub(super) const BYTES_PER_PIXEL: usize = 4;

/// Bound for draining stale GL errors (the queue is finite; this only stops a
/// pathological context-lost loop).
pub(super) const MAX_DRAINED_ERRORS: usize = 8;

// ---------------------------------------------------------------------------
// opengl32 / gdi32 entry points (the GL 1.1 + WGL surface; FBO entry points
// are resolved at runtime through wglGetProcAddress).
// ---------------------------------------------------------------------------

// SAFETY (whole block): plain Win32/GL exports with the documented signatures
// from wingdi/opengl32; every call site below upholds the pointer lifetime
// rules and runs on the thread owning the WGL context.
#[link(name = "opengl32")]
unsafe extern "system" {
    pub(super) fn wglCreateContext(hdc: HDC) -> *mut c_void;
    pub(super) fn wglDeleteContext(context: *mut c_void) -> i32;
    pub(super) fn wglMakeCurrent(hdc: HDC, context: *mut c_void) -> i32;
    /// Public within the crate: the interop bridge (interop.rs) resolves the
    /// `wglDX*` entry points through the same loader.
    pub(crate) fn wglGetProcAddress(name: *const c_char) -> *const c_void;
    pub(super) fn glGenTextures(n: c_int, textures: *mut u32);
    pub(super) fn glBindTexture(target: u32, texture: u32);
    pub(super) fn glTexImage2D(
        target: u32,
        level: c_int,
        internal_format: c_int,
        width: c_int,
        height: c_int,
        border: c_int,
        format: u32,
        pixel_type: u32,
        pixels: *const c_void,
    );
    pub(super) fn glTexParameteri(target: u32, name: u32, param: c_int);
    pub(super) fn glDeleteTextures(n: c_int, textures: *const u32);
    pub(super) fn glReadPixels(
        x: c_int,
        y: c_int,
        width: c_int,
        height: c_int,
        format: u32,
        pixel_type: u32,
        pixels: *mut c_void,
    );
    pub(super) fn glClearColor(red: f32, green: f32, blue: f32, alpha: f32);
    pub(super) fn glClear(mask: u32);
    pub(super) fn glGetError() -> u32;
}

#[link(name = "gdi32")]
unsafe extern "system" {
    pub(super) fn ChoosePixelFormat(hdc: HDC, format: *const PixelFormatDescriptor) -> i32;
    pub(super) fn SetPixelFormat(
        hdc: HDC,
        format: i32,
        description: *const PixelFormatDescriptor,
    ) -> i32;
}

/// `PIXELFORMATDESCRIPTOR` (wingdi.h). Size pinned to the C ABI by a unit
/// test — a drift here would silently corrupt `SetPixelFormat`.
#[repr(C)]
pub(super) struct PixelFormatDescriptor {
    size: u16,
    version: u16,
    flags: u32,
    pixel_type: u8,
    color_bits: u8,
    red_bits: u8,
    red_shift: u8,
    green_bits: u8,
    green_shift: u8,
    blue_bits: u8,
    blue_shift: u8,
    alpha_bits: u8,
    alpha_shift: u8,
    accum_bits: u8,
    accum_red_bits: u8,
    accum_green_bits: u8,
    accum_blue_bits: u8,
    accum_alpha_bits: u8,
    depth_bits: u8,
    stencil_bits: u8,
    aux_buffers: u8,
    layer_type: u8,
    reserved: u8,
    layer_mask: u32,
    visible_mask: u32,
    damage_mask: u32,
}

const PFD_DRAW_TO_WINDOW: u32 = 0x0000_0004;
const PFD_SUPPORT_OPENGL: u32 = 0x0000_0020;
const PFD_DOUBLEBUFFER: u32 = 0x0000_0001;
const PFD_TYPE_RGBA: u8 = 0;

impl PixelFormatDescriptor {
    /// The RGBA format every GL driver accepts: 32-bit color, no depth or
    /// stencil (rendering goes to our own FBO, never to the window).
    pub(super) fn rgba() -> Self {
        Self {
            size: std::mem::size_of::<Self>() as u16,
            version: 1,
            flags: PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL | PFD_DOUBLEBUFFER,
            pixel_type: PFD_TYPE_RGBA,
            color_bits: 32,
            red_bits: 0,
            red_shift: 0,
            green_bits: 0,
            green_shift: 0,
            blue_bits: 0,
            blue_shift: 0,
            alpha_bits: 0,
            alpha_shift: 0,
            accum_bits: 0,
            accum_red_bits: 0,
            accum_green_bits: 0,
            accum_blue_bits: 0,
            accum_alpha_bits: 0,
            depth_bits: 0,
            stencil_bits: 0,
            aux_buffers: 0,
            layer_type: 0, // PFD_MAIN_PLANE
            reserved: 0,
            layer_mask: 0,
            visible_mask: 0,
            damage_mask: 0,
        }
    }
}

// ---------------------------------------------------------------------------
// Entry point loading
// ---------------------------------------------------------------------------

/// `wglGetProcAddress` reports failure as NULL or the sentinels 1/2/3/-1
/// (documented by Microsoft); treating a sentinel as a function pointer would
/// call garbage. Shared with the interop loader (interop.rs).
pub(crate) fn is_wgl_failure(proc: *const c_void) -> bool {
    proc.is_null() || matches!(proc as usize, 1..=3) || proc as usize == usize::MAX
}

/// Resolve one GL entry point: `wglGetProcAddress` first (extensions and GL
/// 1.2+), then `GetProcAddress` on the opengl32 module (the GL 1.1 exports,
/// for which wglGetProcAddress returns NULL).
pub(super) fn load_gl_entry(module: HMODULE, name: &CStr) -> Result<*const c_void, String> {
    let proc = unsafe { wglGetProcAddress(name.as_ptr()) };
    if !is_wgl_failure(proc) {
        return Ok(proc);
    }
    match unsafe { GetProcAddress(module, name.as_ptr() as *const u8) } {
        Some(symbol) => Ok(symbol as *const c_void),
        None => Err(format!(
            "GL entry point {} is not available (wglGetProcAddress and GetProcAddress both failed)",
            name.to_string_lossy()
        )),
    }
}

/// Typed variant of [`load_gl_entry`] for a function-pointer field.
pub(super) fn load_gl_fn<T: Copy>(module: HMODULE, name: &CStr) -> Result<T, String> {
    let proc = load_gl_entry(module, name)?;
    Ok(unsafe { std::mem::transmute_copy::<*const c_void, T>(&proc) })
}

/// The `get_proc_address` callback mpv resolves its GL functions through
/// (render_gl.h). `ctx` is the opengl32 `HMODULE`.
///
/// # Safety
/// Contractually an `extern "C"` callback: `ctx` must be the HMODULE passed in
/// `mpv_opengl_init_params.get_proc_address_ctx`, `name` a NUL-terminated
/// string (or NULL, tolerated).
pub(crate) unsafe extern "C" fn gl_get_proc_address(
    ctx: *mut c_void,
    name: *const c_char,
) -> *mut c_void {
    if name.is_null() {
        return ptr::null_mut();
    }
    let proc = wglGetProcAddress(name);
    if !is_wgl_failure(proc) {
        return proc as *mut c_void;
    }
    match GetProcAddress(ctx as HMODULE, name as *const u8) {
        Some(symbol) => symbol as *mut c_void,
        None => ptr::null_mut(),
    }
}

pub(super) fn last_error() -> u32 {
    // SAFETY: reading this thread's last-error value; no preconditions.
    unsafe { GetLastError() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::mem::size_of;

    /// Pins the Rust declaration to the wingdi.h ABI (x64); a drift would
    /// silently corrupt `SetPixelFormat`.
    #[test]
    fn pixel_format_descriptor_matches_the_wingdi_layout() {
        assert_eq!(size_of::<PixelFormatDescriptor>(), 40);
        assert_eq!(PixelFormatDescriptor::rgba().size, 40);
    }

    #[test]
    #[allow(clippy::manual_dangling_ptr)]
    fn wgl_failure_sentinels_are_not_function_pointers() {
        // 1/2/3/-1 are the literal error values wglGetProcAddress returns, not
        // dangling pointers: they must be compared by value, so ptr::dangling
        // (alignment only) would not reproduce them.
        assert!(is_wgl_failure(ptr::null()));
        assert!(is_wgl_failure(1usize as *const c_void));
        assert!(is_wgl_failure(2usize as *const c_void));
        assert!(is_wgl_failure(3usize as *const c_void));
        assert!(is_wgl_failure(usize::MAX as *const c_void));
        assert!(!is_wgl_failure(0x1000usize as *const c_void));
    }
}
