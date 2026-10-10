//! GL/WGL layer owned by the render thread: a hidden 1x1 anchor window, a WGL
//! context on it, the GL entry point loader mpv resolves functions through,
//! and the RGBA8 texture + FBO the video frames render into.
//!
//! The anchor window is created with `WS_POPUP` and never gets `WS_VISIBLE`;
//! `ShowWindow` is never called anywhere in this file. It exists only to give
//! WGL an HDC — nothing is ever presented (S3 owns presentation).
//!
//! Every Win32/GL call that can fail returns `Err` with the failed call and
//! the Win32/GL error code. GL 1.1 entry points are linked statically
//! (opengl32); the framebuffer-object entry points are looked up through
//! `wglGetProcAddress` (the GL 1.1 exports return NULL there).

use std::ffi::{c_char, c_int, c_void, CStr};
use std::path::Path;
use std::ptr;

use windows_sys::Win32::Foundation::{
    GetLastError, ERROR_CLASS_ALREADY_EXISTS, HINSTANCE, HMODULE, HWND,
};
use windows_sys::Win32::Graphics::Gdi::{GetDC, ReleaseDC, HDC};
use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, RegisterClassW, WNDCLASSW, WS_POPUP,
};

/// Window class for the anchor. Registered once per process; a second
/// registration legitimately fails with `ERROR_CLASS_ALREADY_EXISTS`.
const ANCHOR_CLASS_NAME: &str = "DrPlayRenderAnchor";

/// The anchor is 1x1 and hidden: it is never shown and never sized.
const ANCHOR_SIZE: i32 = 1;

/// Upper bound for the surface/FBO dimension accepted from callers. 4K is
/// 3840 wide; every driver we target reports `GL_MAX_TEXTURE_SIZE` >= 16384,
/// so this bound is the app's own sanity check, not the driver's.
pub(crate) const MAX_TEXTURE_DIMENSION: u32 = 16384;

/// RGBA8: the texture internal format (and `mpv_opengl_fbo.internal_format`).
pub(crate) const GL_RGBA8: u32 = 0x8058;
/// `GL_TEXTURE_2D`: the object type the interop bridge registers.
pub(crate) const GL_TEXTURE_2D: u32 = 0x0DE1;
const GL_RGBA: u32 = 0x1908;
const GL_UNSIGNED_BYTE: u32 = 0x1401;
const GL_TEXTURE_MIN_FILTER: u32 = 0x2801;
const GL_TEXTURE_MAG_FILTER: u32 = 0x2800;
const GL_LINEAR: c_int = 0x2601;
const GL_TEXTURE_WRAP_S: u32 = 0x2802;
const GL_TEXTURE_WRAP_T: u32 = 0x2803;
const GL_CLAMP_TO_EDGE: c_int = 0x812F;
const GL_FRAMEBUFFER: u32 = 0x8D40;
const GL_COLOR_ATTACHMENT0: u32 = 0x8CE0;
const GL_FRAMEBUFFER_COMPLETE: u32 = 0x8CD5;
const GL_COLOR_BUFFER_BIT: u32 = 0x0000_4000;
const GL_NO_ERROR: u32 = 0;

const BYTES_PER_PIXEL: usize = 4;

/// Bound for draining stale GL errors (the queue is finite; this only stops a
/// pathological context-lost loop).
const MAX_DRAINED_ERRORS: usize = 8;

// ---------------------------------------------------------------------------
// opengl32 / gdi32 entry points (the GL 1.1 + WGL surface; FBO entry points
// are resolved at runtime through wglGetProcAddress).
// ---------------------------------------------------------------------------

// SAFETY (whole block): plain Win32/GL exports with the documented signatures
// from wingdi/opengl32; every call site below upholds the pointer lifetime
// rules and runs on the thread owning the WGL context.
#[link(name = "opengl32")]
unsafe extern "system" {
    fn wglCreateContext(hdc: HDC) -> *mut c_void;
    fn wglDeleteContext(context: *mut c_void) -> i32;
    fn wglMakeCurrent(hdc: HDC, context: *mut c_void) -> i32;
    /// Public within the crate: the interop bridge (interop.rs) resolves the
    /// `wglDX*` entry points through the same loader.
    pub(crate) fn wglGetProcAddress(name: *const c_char) -> *const c_void;
    fn glGenTextures(n: c_int, textures: *mut u32);
    fn glBindTexture(target: u32, texture: u32);
    fn glTexImage2D(
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
    fn glTexParameteri(target: u32, name: u32, param: c_int);
    fn glDeleteTextures(n: c_int, textures: *const u32);
    fn glReadPixels(
        x: c_int,
        y: c_int,
        width: c_int,
        height: c_int,
        format: u32,
        pixel_type: u32,
        pixels: *mut c_void,
    );
    fn glClearColor(red: f32, green: f32, blue: f32, alpha: f32);
    fn glClear(mask: u32);
    fn glGetError() -> u32;
}

#[link(name = "gdi32")]
unsafe extern "system" {
    fn ChoosePixelFormat(hdc: HDC, format: *const PixelFormatDescriptor) -> i32;
    fn SetPixelFormat(hdc: HDC, format: i32, description: *const PixelFormatDescriptor) -> i32;
}

/// `PIXELFORMATDESCRIPTOR` (wingdi.h). Size pinned to the C ABI by a unit
/// test — a drift here would silently corrupt `SetPixelFormat`.
#[repr(C)]
struct PixelFormatDescriptor {
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
    fn rgba() -> Self {
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
fn load_gl_entry(module: HMODULE, name: &CStr) -> Result<*const c_void, String> {
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
fn load_gl_fn<T: Copy>(module: HMODULE, name: &CStr) -> Result<T, String> {
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

/// Framebuffer-object entry points (GL_ARB_framebuffer_object; core since GL
/// 3.0). Resolved at GL-context creation time, not statically, because they
/// are extension/1.2+ entry points.
struct FboApi {
    gen_framebuffers: unsafe extern "system" fn(c_int, *mut u32),
    bind_framebuffer: unsafe extern "system" fn(u32, u32),
    framebuffer_texture_2d: unsafe extern "system" fn(u32, u32, u32, u32, c_int),
    check_framebuffer_status: unsafe extern "system" fn(u32) -> u32,
    delete_framebuffers: unsafe extern "system" fn(c_int, *const u32),
}

impl FboApi {
    fn load(module: HMODULE) -> Result<Self, String> {
        Ok(Self {
            gen_framebuffers: load_gl_fn(module, c"glGenFramebuffers")?,
            bind_framebuffer: load_gl_fn(module, c"glBindFramebuffer")?,
            framebuffer_texture_2d: load_gl_fn(module, c"glFramebufferTexture2D")?,
            check_framebuffer_status: load_gl_fn(module, c"glCheckFramebufferStatus")?,
            delete_framebuffers: load_gl_fn(module, c"glDeleteFramebuffers")?,
        })
    }
}

// ---------------------------------------------------------------------------
// Anchor window + WGL context + render target
// ---------------------------------------------------------------------------

fn last_error() -> u32 {
    // SAFETY: reading this thread's last-error value; no preconditions.
    unsafe { GetLastError() }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Cleanup that must happen in spec §18 order on the render thread: GL objects
/// first (context still current), then WGL current/context, DC, window.
fn release_anchor(window: &mut HWND, dc: &mut HDC, context: &mut *mut c_void) {
    // SAFETY: every pointer is either null (skipped) or an object this thread
    // created and still owns; each call is on the thread that made it.
    unsafe {
        if !context.is_null() {
            if wglMakeCurrent(*dc, ptr::null_mut()) == 0 {
                log::warn!("[player] wglMakeCurrent(NULL) failed (win32 error {})", last_error());
            }
            if wglDeleteContext(*context) == 0 {
                log::warn!("[player] wglDeleteContext failed (win32 error {})", last_error());
            }
            *context = ptr::null_mut();
        }
        if !dc.is_null() {
            ReleaseDC(*window, *dc);
            *dc = ptr::null_mut();
        }
        if !window.is_null() {
            if DestroyWindow(*window) == 0 {
                log::warn!("[player] DestroyWindow(anchor) failed (win32 error {})", last_error());
            }
            *window = ptr::null_mut();
        }
    }
}

/// Partial-state owner during `GlContext::create`: whatever was created so far
/// is released (in spec §18 order) when the constructor fails. On success the
/// caller disarms it and the pieces transfer into the `GlContext`.
struct AnchorGuard {
    window: HWND,
    dc: HDC,
    context: *mut c_void,
}

impl AnchorGuard {
    fn new() -> Result<Self, String> {
        // SAFETY: a null module name asks for this process's image handle.
        let instance = unsafe { GetModuleHandleW(ptr::null()) };
        if instance.is_null() {
            return Err(format!("GetModuleHandleW(NULL) failed (win32 error {})", last_error()));
        }
        register_anchor_class(instance)?;

        let class = wide(ANCHOR_CLASS_NAME);
        // SAFETY: the class name string outlives the call (Windows copies it);
        // no parent/menu for a popup; hidden by construction (no WS_VISIBLE).
        let window = unsafe {
            CreateWindowExW(
                0,
                class.as_ptr(),
                ptr::null(),
                WS_POPUP,
                0,
                0,
                ANCHOR_SIZE,
                ANCHOR_SIZE,
                ptr::null_mut(),
                ptr::null_mut(),
                instance,
                ptr::null(),
            )
        };
        if window.is_null() {
            return Err(format!(
                "CreateWindowExW({ANCHOR_CLASS_NAME}) failed (win32 error {})",
                last_error()
            ));
        }
        // SAFETY: `window` is a live window created just above on this thread.
        let dc = unsafe { GetDC(window) };
        if dc.is_null() {
            let error = last_error();
            // SAFETY: `window` is live and owned by this thread.
            unsafe { DestroyWindow(window) };
            return Err(format!("GetDC(anchor) failed (win32 error {error})"));
        }
        let mut guard = AnchorGuard { window, dc, context: ptr::null_mut() };

        let format = unsafe { ChoosePixelFormat(dc, &PixelFormatDescriptor::rgba()) };
        if format == 0 {
            return Err(guard.fail(format!("ChoosePixelFormat failed (win32 error {})", last_error())));
        }
        let description = PixelFormatDescriptor::rgba();
        if unsafe { SetPixelFormat(dc, format, &description) } == 0 {
            return Err(guard.fail(format!("SetPixelFormat failed (win32 error {})", last_error())));
        }
        let context = unsafe { wglCreateContext(dc) };
        if context.is_null() {
            return Err(guard.fail(format!("wglCreateContext failed (win32 error {})", last_error())));
        }
        guard.context = context;
        if unsafe { wglMakeCurrent(dc, context) } == 0 {
            return Err(guard.fail(format!("wglMakeCurrent failed (win32 error {})", last_error())));
        }
        Ok(guard)
    }

    fn fail(self, message: String) -> String {
        drop(self); // releases whatever was created, in spec §18 order
        message
    }
}

impl Drop for AnchorGuard {
    fn drop(&mut self) {
        release_anchor(&mut self.window, &mut self.dc, &mut self.context);
    }
}

/// Register the anchor window class once per process. Re-registration is
/// success (`ERROR_CLASS_ALREADY_EXISTS`), like the video host class.
fn register_anchor_class(instance: HINSTANCE) -> Result<(), String> {
    let class = wide(ANCHOR_CLASS_NAME);
    let window_class = WNDCLASSW {
        style: 0,
        lpfnWndProc: Some(DefWindowProcW),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: instance,
        hIcon: ptr::null_mut(),
        hCursor: ptr::null_mut(),
        hbrBackground: ptr::null_mut(),
        lpszMenuName: ptr::null(),
        lpszClassName: class.as_ptr(),
    };
    let atom = unsafe { RegisterClassW(&window_class) };
    if atom == 0 {
        let error = last_error();
        if error != ERROR_CLASS_ALREADY_EXISTS {
            return Err(format!(
                "RegisterClassW({ANCHOR_CLASS_NAME}) failed (win32 error {error})"
            ));
        }
    }
    Ok(())
}

fn clear_gl_errors() {
    for _ in 0..MAX_DRAINED_ERRORS {
        // SAFETY: glGetError has no preconditions; the context is current.
        if unsafe { glGetError() } == GL_NO_ERROR {
            return;
        }
    }
}

fn check_gl_error(step: &str) -> Result<(), String> {
    // SAFETY: glGetError has no preconditions; the context is current.
    let code = unsafe { glGetError() };
    if code == GL_NO_ERROR {
        Ok(())
    } else {
        Err(format!("{step} failed (GL error 0x{code:X})"))
    }
}

fn validate_dimension(width: u32, height: u32) -> Result<(), String> {
    if width == 0 || height == 0 || width > MAX_TEXTURE_DIMENSION || height > MAX_TEXTURE_DIMENSION {
        return Err(format!(
            "invalid render target size {width}x{height} (must be 1..={MAX_TEXTURE_DIMENSION})"
        ));
    }
    Ok(())
}

/// The complete GL side of the render thread: anchor window, WGL context,
/// loaded entry points, texture + FBO. Created, used and dropped exclusively
/// on the render thread (GL contexts have thread affinity).
pub(crate) struct GlContext {
    window: HWND,
    dc: HDC,
    context: *mut c_void,
    module: HMODULE,
    fbo_api: FboApi,
    texture: u32,
    fbo: u32,
    width: u32,
    height: u32,
}

impl GlContext {
    /// Create the anchor window + WGL context + RGBA8 texture + FBO.
    pub(crate) fn create(width: u32, height: u32) -> Result<Self, String> {
        validate_dimension(width, height)?;
        let guard = AnchorGuard::new()?;
        // SAFETY: static module name; the DLL is running (statically
        // imported), so the handle is non-null here.
        let module = unsafe { GetModuleHandleW(wide("opengl32.dll").as_ptr()) };
        if module.is_null() {
            return Err(format!("GetModuleHandleW(opengl32.dll) failed (win32 error {})", last_error()));
        }
        let fbo_api = FboApi::load(module)?;
        let (texture, fbo) = create_target(&fbo_api, width, height)?;
        let gl_context = GlContext {
            window: guard.window,
            dc: guard.dc,
            context: guard.context,
            module,
            fbo_api,
            texture,
            fbo,
            width,
            height,
        };
        std::mem::forget(guard); // ownership transferred into `gl_context`
        Ok(gl_context)
    }

    /// The `HMODULE` handed to mpv as `get_proc_address_ctx`.
    pub(crate) fn proc_address_ctx(&self) -> *mut c_void {
        self.module
    }

    /// FBO name for `mpv_opengl_fbo`.
    pub(crate) fn framebuffer(&self) -> c_int {
        self.fbo as c_int
    }

    /// The color-attachment texture object: registered with the D3D11 texture
    /// by the S3 interop bridge.
    pub(crate) fn texture(&self) -> u32 {
        self.texture
    }

    pub(crate) fn width(&self) -> u32 {
        self.width
    }

    pub(crate) fn height(&self) -> u32 {
        self.height
    }

    /// Reallocate the texture storage to the new size; the FBO attachment
    /// references the same texture object and stays valid.
    pub(crate) fn resize(&mut self, width: u32, height: u32) -> Result<(), String> {
        validate_dimension(width, height)?;
        clear_gl_errors();
        // SAFETY: the context is current; ids were created by this thread.
        unsafe {
            glBindTexture(GL_TEXTURE_2D, self.texture);
            glTexImage2D(
                GL_TEXTURE_2D,
                0,
                GL_RGBA8 as c_int,
                width as c_int,
                height as c_int,
                0,
                GL_RGBA,
                GL_UNSIGNED_BYTE,
                ptr::null(),
            );
        }
        check_gl_error("glTexImage2D (resize)")?;
        self.width = width;
        self.height = height;
        // SAFETY: the FBO is complete again — same attachment, new storage.
        let status = unsafe {
            (self.fbo_api.bind_framebuffer)(GL_FRAMEBUFFER, self.fbo);
            (self.fbo_api.check_framebuffer_status)(GL_FRAMEBUFFER)
        };
        if status != GL_FRAMEBUFFER_COMPLETE {
            return Err(format!("framebuffer incomplete after resize (GL status 0x{status:X})"));
        }
        Ok(())
    }

    /// Read the whole FBO back (RGBA8, GL row order: row 0 = bottom).
    pub(crate) fn read_pixels(&self) -> Result<Vec<u8>, String> {
        let mut buffer =
            vec![0u8; (self.width as usize) * (self.height as usize) * BYTES_PER_PIXEL];
        clear_gl_errors();
        // SAFETY: the context is current; `buffer` has exactly width*height*4
        // readable-writable bytes as glReadPixels RGBA8 writes.
        unsafe {
            (self.fbo_api.bind_framebuffer)(GL_FRAMEBUFFER, self.fbo);
            glReadPixels(
                0,
                0,
                self.width as c_int,
                self.height as c_int,
                GL_RGBA,
                GL_UNSIGNED_BYTE,
                buffer.as_mut_ptr().cast(),
            );
        }
        check_gl_error("glReadPixels")?;
        Ok(buffer)
    }
}

impl Drop for GlContext {
    fn drop(&mut self) {
        // SAFETY: ids were created with this context current on this thread;
        // deletion happens with it current still.
        unsafe {
            if self.fbo != 0 {
                (self.fbo_api.delete_framebuffers)(1, &self.fbo);
                self.fbo = 0;
            }
            if self.texture != 0 {
                glDeleteTextures(1, &self.texture);
                self.texture = 0;
            }
        }
        release_anchor(&mut self.window, &mut self.dc, &mut self.context);
    }
}

/// Create the RGBA8 texture + FBO pair and verify completeness. A partial
/// failure leaves the objects to the context teardown (deleting the context
/// reclaims every GL object it owns).
fn create_target(fbo_api: &FboApi, width: u32, height: u32) -> Result<(u32, u32), String> {
    clear_gl_errors();
    let mut texture: u32 = 0;
    // SAFETY: out-parameter is a live local; context is current.
    unsafe { glGenTextures(1, &mut texture) };
    if texture == 0 {
        return Err("glGenTextures returned no texture".to_string());
    }
    // SAFETY: `texture` was just generated on this context; the texture data
    // pointer is NULL (storage only, no upload).
    unsafe {
        glBindTexture(GL_TEXTURE_2D, texture);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
        glTexImage2D(
            GL_TEXTURE_2D,
            0,
            GL_RGBA8 as c_int,
            width as c_int,
            height as c_int,
            0,
            GL_RGBA,
            GL_UNSIGNED_BYTE,
            ptr::null(),
        );
    }
    check_gl_error("glTexImage2D")?;

    let mut fbo: u32 = 0;
    // SAFETY: out-parameter is a live local; context is current.
    unsafe {
        (fbo_api.gen_framebuffers)(1, &mut fbo);
        if fbo == 0 {
            return Err("glGenFramebuffers returned no framebuffer".to_string());
        }
        (fbo_api.bind_framebuffer)(GL_FRAMEBUFFER, fbo);
        (fbo_api.framebuffer_texture_2d)(
            GL_FRAMEBUFFER,
            GL_COLOR_ATTACHMENT0,
            GL_TEXTURE_2D,
            texture,
            0,
        );
    }
    // SAFETY: the FBO is bound; the query has no other precondition.
    let status = unsafe { (fbo_api.check_framebuffer_status)(GL_FRAMEBUFFER) };
    if status != GL_FRAMEBUFFER_COMPLETE {
        return Err(format!("framebuffer is incomplete (GL status 0x{status:X})"));
    }
    // A deterministic start state: an unrendered FBO reads back black.
    // SAFETY: plain state setters on the current context + bound FBO.
    unsafe {
        glClearColor(0.0, 0.0, 0.0, 1.0);
        glClear(GL_COLOR_BUFFER_BIT);
    }
    Ok((texture, fbo))
}

// ---------------------------------------------------------------------------
// MIGRATION-ONLY frame dump (S7): a real 24-bit BMP the Main Agent can open.
//
// Purpose: the render counters prove mpv rendered AND DirectComposition
// accepted the frame, but not whether the pixels are actually there. A black
// FBO and a healthy FBO both end in `presented=N` with no error. Writing the
// readback to a file answers it without depending on a screenshot, and the
// per-channel min/max/mean answers it in the log even when the file is never
// opened.
//
// Hand-rolled on purpose: a PNG encoder would be a new dependency for a
// temporary diagnostic, and BMP needs no compression or encoder at all.
// ---------------------------------------------------------------------------

/// Byte offset where the pixel array starts: BITMAPFILEHEADER (14) +
/// BITMAPINFOHEADER (40).
const BMP_PIXEL_OFFSET: usize = 54;
/// The only bit depth written. 32-bit would carry a fourth byte per pixel
/// that no viewer needs; 24 is the plain uncompressed baseline.
const BMP_BITS_PER_PIXEL: u32 = 24;

/// Per-channel minimum, maximum and mean over a WHOLE readback. Whole-frame
/// statistics, not a spot check: one non-black pixel says nothing, whereas
/// "every R, G and B sample is 0" is proof of a black frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ChannelStats {
    pub(crate) min: u8,
    pub(crate) max: u8,
    pub(crate) avg: f32,
}

impl ChannelStats {
    /// One-line rendering for the dump log line (`r[0..255 mean=12.3]`).
    pub(crate) fn summary(&self, name: &str) -> String {
        format!("{name}[min={} max={} mean={:.1}]", self.min, self.max, self.avg)
    }
}

/// Min/max/mean of each of the four channels of an RGBA8 buffer. A trailing
/// partial pixel is ignored rather than panicking, so a truncated readback
/// degrades to slightly-wrong statistics instead of a crashed render thread.
pub(crate) fn channel_stats(rgba: &[u8]) -> [ChannelStats; 4] {
    let mut min = [u8::MAX; 4];
    let mut max = [0u8; 4];
    let mut sum = [0u64; 4];
    let mut pixels = 0u64;
    for pixel in rgba.chunks_exact(BYTES_PER_PIXEL) {
        for (channel, &value) in pixel.iter().enumerate() {
            min[channel] = min[channel].min(value);
            max[channel] = max[channel].max(value);
            sum[channel] += u64::from(value);
        }
        pixels += 1;
    }
    let divisor = pixels.max(1) as f32;
    std::array::from_fn(|channel| ChannelStats {
        min: min[channel],
        max: max[channel],
        // An empty readback reports min=255/max=0; zero the mean instead so a
        // zero-pixel dump cannot masquerade as real signal.
        avg: if pixels == 0 { 0.0 } else { sum[channel] as f32 / divisor },
    })
}

/// Bytes per pixel-array row, padded up to the 4-byte boundary every BMP row
/// must end on. Computed in u64 so a hostile width cannot wrap.
///
/// 24-bit means THREE bytes per pixel in the file, not 24: the stride is a
/// byte count, so the bit depth has to be divided by 8 before it is scaled by
/// the width.
fn bmp_row_stride(width: u32) -> u64 {
    let bytes_per_pixel = u64::from(BMP_BITS_PER_PIXEL / 8);
    (u64::from(width) * bytes_per_pixel).div_ceil(4) * 4
}

/// Encode an RGBA8 readback as a complete, uncompressed 24-bit BMP file.
///
/// # Orientation — read this before trusting the picture
///
/// `glReadPixels` returns GL row order: **row 0 is the BOTTOM** row of the
/// rendered frame. A BMP whose `biHeight` is POSITIVE is stored bottom-up,
/// i.e. its first stored scanline is the image's bottom scanline. The two
/// conventions agree, so the readback rows are written out in the order they
/// arrive and the file reproduces the frame exactly as it was rendered. No
/// row flip is applied.
///
/// What this file therefore shows is the raw FBO memory order. mpv's GL
/// renderer writes the frame top-down (memory row 0 = the picture's TOP),
/// while glReadPixels + a bottom-up BMP both treat the first memory row as
/// the image's bottom — so the viewer shows the picture vertically mirrored.
/// That is this file's convention, not an on-screen flip: D3D11 and
/// DirectComposition use the same row 0 = top order as mpv, so the on-screen
/// presentation is upright with no flip anywhere (composition.rs applies
/// scale/offset only). Reading the FBO after `present()` is safe and
/// faithful: presentation COPIES the interop texture into D3D11, it does not
/// consume or clear the GL framebuffer.
///
/// # Colour
///
/// 24-bit BMP has no alpha channel and stores pixels in BGR order, which is
/// the format's native byte order, so R/G/B are emitted swapped and the alpha
/// byte is dropped. Rows are zero-padded to the stride above.
pub(crate) fn encode_bmp24(
    width: u32,
    height: u32,
    rgba: &[u8],
) -> Result<Vec<u8>, String> {
    if width == 0 || height == 0 {
        return Err(format!("cannot encode a {width}x{height} frame into a BMP"));
    }
    let expected = u64::from(width) * u64::from(height) * BYTES_PER_PIXEL as u64;
    if rgba.len() as u64 != expected {
        return Err(format!(
            "RGBA buffer is {} bytes, but {width}x{height} needs {expected}",
            rgba.len()
        ));
    }
    let stride = bmp_row_stride(width);
    let image_size = stride * u64::from(height);
    let file_size = BMP_PIXEL_OFFSET as u64 + image_size;
    if file_size > u64::from(u32::MAX) {
        return Err(format!("a {width}x{height} frame does not fit a 32-bit BMP header"));
    }
    let mut out = Vec::with_capacity(file_size as usize);

    // BITMAPFILEHEADER. `bfOffBits` is the one field a decoder cannot guess.
    out.extend_from_slice(b"BM");
    out.extend_from_slice(&(file_size as u32).to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // bfReserved1
    out.extend_from_slice(&0u16.to_le_bytes()); // bfReserved2
    out.extend_from_slice(&(BMP_PIXEL_OFFSET as u32).to_le_bytes());

    // BITMAPINFOHEADER. The positive height is what selects bottom-up row
    // order and matches glReadPixels; see the orientation note above.
    out.extend_from_slice(&40u32.to_le_bytes()); // biSize
    out.extend_from_slice(&(width as i32).to_le_bytes());
    out.extend_from_slice(&(height as i32).to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // biPlanes
    out.extend_from_slice(&(BMP_BITS_PER_PIXEL as u16).to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes()); // biCompression = BI_RGB
    out.extend_from_slice(&(image_size as u32).to_le_bytes());
    out.extend_from_slice(&2835i32.to_le_bytes()); // 72 DPI
    out.extend_from_slice(&2835i32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes()); // biClrUsed: no palette
    out.extend_from_slice(&0u32.to_le_bytes()); // biClrImportant

    debug_assert_eq!(out.len(), BMP_PIXEL_OFFSET, "header must end at bfOffBits");

    let width_usize = width as usize;
    let line_bytes = width_usize * BYTES_PER_PIXEL;
    // 24-bit = 3 bytes per pixel in the file, so the padding is whatever the
    // stride adds on top of the unpadded row.
    let unpadded_row = u64::from(width) * u64::from(BMP_BITS_PER_PIXEL / 8);
    let padding = (stride - unpadded_row) as usize;
    for row in 0..height as usize {
        let line = &rgba[row * line_bytes..(row + 1) * line_bytes];
        for pixel in line.chunks_exact(BYTES_PER_PIXEL) {
            out.push(pixel[2]); // B
            out.push(pixel[1]); // G
            out.push(pixel[0]); // R
        }
        out.resize(out.len() + padding, 0); // row padding must be zeroed
    }

    debug_assert_eq!(out.len() as u64, file_size, "payload must match the declared size");
    Ok(out)
}

/// Encode a readback and write it to `path`, returning the whole-frame
/// statistics for the log line plus the number of bytes written. The
/// statistics are computed from the SAME buffer that was written, so the
/// numbers in the log always describe the pixels in the file.
pub(crate) fn write_bmp24(
    path: &Path,
    width: u32,
    height: u32,
    rgba: &[u8],
) -> Result<([ChannelStats; 4], usize), String> {
    let stats = channel_stats(rgba);
    let encoded = encode_bmp24(width, height, rgba)?;
    let written = encoded.len();
    std::fs::write(path, &encoded)
        .map_err(|write_error| format!("cannot write {}: {write_error}", path.display()))?;
    Ok((stats, written))
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
    fn wgl_failure_sentinels_are_not_function_pointers() {
        assert!(is_wgl_failure(ptr::null()));
        assert!(is_wgl_failure(1usize as *const c_void));
        assert!(is_wgl_failure(2usize as *const c_void));
        assert!(is_wgl_failure(3usize as *const c_void));
        assert!(is_wgl_failure(usize::MAX as *const c_void));
        assert!(!is_wgl_failure(0x1000usize as *const c_void));
    }

    #[test]
    fn wide_nul_terminates_the_utf16_encoding() {
        let encoded = wide("abc");
        assert_eq!(encoded, [b'a' as u16, b'b' as u16, b'c' as u16, 0]);
    }

    #[test]
    fn the_anchor_dimension_validation_bounds_the_target_size() {
        assert!(validate_dimension(1, 1).is_ok());
        assert!(validate_dimension(3840, 2160).is_ok());
        assert!(validate_dimension(0, 720).is_err());
        assert!(validate_dimension(1280, 0).is_err());
        assert!(validate_dimension(MAX_TEXTURE_DIMENSION + 1, 720).is_err());
    }
}
