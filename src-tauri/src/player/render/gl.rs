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
//!
//! Layout: this file owns the context and its lifetime (create, resize, flush,
//! readback, drop). The raw declarations live in [`ffi`] and the render-target
//! GL command sequences in [`fbo`]; the `pub(crate)` re-exports below keep the
//! module's public surface exactly as it was before the split.

use std::ffi::{c_int, c_void};
use std::ptr;

use windows_sys::Win32::Foundation::{ERROR_CLASS_ALREADY_EXISTS, HINSTANCE, HMODULE, HWND};
use windows_sys::Win32::Graphics::Gdi::{GetDC, ReleaseDC, HDC};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, RegisterClassW, WNDCLASSW, WS_POPUP,
};

mod ffi;
mod fbo;

pub(crate) use ffi::{
    gl_get_proc_address, is_wgl_failure, wglGetProcAddress, GL_RGBA8, GL_TEXTURE_2D,
    MAX_TEXTURE_DIMENSION,
};

use ffi::{
    glBindTexture, glDeleteTextures, glReadPixels, glTexImage2D, last_error, load_gl_fn,
    wglCreateContext, wglDeleteContext, wglMakeCurrent, ChoosePixelFormat, PixelFormatDescriptor,
    SetPixelFormat, ANCHOR_CLASS_NAME, ANCHOR_SIZE, BYTES_PER_PIXEL,
    GL_FRAMEBUFFER_COMPLETE, GL_RGBA, GL_UNSIGNED_BYTE,
};

use fbo::{check_gl_error, clear_gl_errors, create_target, FboApi};

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
    /// `glFlush`, loaded through the same `load_gl_fn` helper as `fbo_api`
    /// (see `flush`).
    flush: unsafe extern "system" fn(),
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
        // `glFlush`, needed by the NV_DX_interop hand-off (see `flush`). Loaded
        // with the same `load_gl_fn` helper as `FboApi`, so a missing symbol is
        // a typed error naming it rather than a failure at link time.
        let flush: unsafe extern "system" fn() = load_gl_fn(module, c"glFlush")?;
        let (texture, fbo) = create_target(&fbo_api, width, height)?;
        let gl_context = GlContext {
            window: guard.window,
            dc: guard.dc,
            context: guard.context,
            module,
            fbo_api,
            flush,
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
        self.fbo_api.bind(self.fbo);
        let status = self.fbo_api.status();
        if status != GL_FRAMEBUFFER_COMPLETE {
            return Err(format!("framebuffer incomplete after resize (GL status 0x{status:X})"));
        }
        Ok(())
    }

    /// `glFlush`: submit the commands queued by mpv's render so the driver
    /// starts executing them.
    ///
    /// This exists for the NV_DX_interop hand-off, NOT for GL itself. mpv's
    /// render call only ENQUEUES the drawing commands; nothing has told the GPU
    /// to run them yet. The very next thing the render loop does is unlock the
    /// interop object, and Direct3D copies that texture immediately — so
    /// without a flush in between, D3D copies the texture before the frame has
    /// been submitted and the screen stays black, while a readback of the SAME
    /// texture a moment later (now submitted) looks perfectly correct. That
    /// asymmetry is the whole bug this call fixes.
    ///
    /// A flush, never a `glFinish`: a flush guarantees the queued commands are
    /// SUBMITTED in order, which is all the D3D copy needs; a finish blocks
    /// until every one of them has EXECUTED, stalling the pipeline once per
    /// frame for no benefit. See the module docs in interop.rs.
    pub(crate) fn flush(&self) {
        // SAFETY: glFlush has no preconditions; the context is current and the
        // pointer was resolved by `load_gl_fn` at creation time.
        unsafe { (self.flush)() };
    }

    /// Read the whole FBO back (RGBA8, GL row order: row 0 = bottom).
    pub(crate) fn read_pixels(&self) -> Result<Vec<u8>, String> {
        let mut buffer =
            vec![0u8; (self.width as usize) * (self.height as usize) * BYTES_PER_PIXEL];
        clear_gl_errors();
        // SAFETY: the context is current; `buffer` has exactly width*height*4
        // readable-writable bytes as glReadPixels RGBA8 writes.
        self.fbo_api.bind(self.fbo);
        unsafe {
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
                self.fbo_api.delete(self.fbo);
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

#[cfg(test)]
mod tests {
    use super::*;

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
