//! Framebuffer objects for the render target: the runtime-resolved FBO entry
//! points, the raw GL command sequences that build the texture + FBO pair, and
//! the GL error helpers those sequences rely on.
//!
//! Every raw GL call for the render target lives here; `gl.rs` owns the
//! context and reaches this module only through the narrow `FboApi` wrappers
//! (`bind`/`status`/`delete`) plus the free functions below, so the struct's
//! function-pointer fields never leak outside.

use std::ffi::c_int;
use std::ptr;

use windows_sys::Win32::Foundation::HMODULE;

use super::ffi::{
    glBindTexture, glClear, glClearColor, glGenTextures, glGetError, glTexImage2D,
    glTexParameteri, load_gl_fn, GL_CLAMP_TO_EDGE, GL_COLOR_ATTACHMENT0, GL_COLOR_BUFFER_BIT,
    GL_FRAMEBUFFER, GL_FRAMEBUFFER_COMPLETE, GL_LINEAR, GL_NO_ERROR, GL_RGBA, GL_RGBA8,
    GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_TEXTURE_MIN_FILTER, GL_TEXTURE_WRAP_S,
    GL_TEXTURE_WRAP_T, GL_UNSIGNED_BYTE, MAX_DRAINED_ERRORS,
};

/// Framebuffer-object entry points (GL_ARB_framebuffer_object; core since GL
/// 3.0). Resolved at GL-context creation time, not statically, because they
/// are extension/1.2+ entry points.
pub(super) struct FboApi {
    gen_framebuffers: unsafe extern "system" fn(c_int, *mut u32),
    bind_framebuffer: unsafe extern "system" fn(u32, u32),
    framebuffer_texture_2d: unsafe extern "system" fn(u32, u32, u32, u32, c_int),
    check_framebuffer_status: unsafe extern "system" fn(u32) -> u32,
    delete_framebuffers: unsafe extern "system" fn(c_int, *const u32),
}

impl FboApi {
    pub(super) fn load(module: HMODULE) -> Result<Self, String> {
        Ok(Self {
            gen_framebuffers: load_gl_fn(module, c"glGenFramebuffers")?,
            bind_framebuffer: load_gl_fn(module, c"glBindFramebuffer")?,
            framebuffer_texture_2d: load_gl_fn(module, c"glFramebufferTexture2D")?,
            check_framebuffer_status: load_gl_fn(module, c"glCheckFramebufferStatus")?,
            delete_framebuffers: load_gl_fn(module, c"glDeleteFramebuffers")?,
        })
    }

    /// Bind `fbo` as the current `GL_FRAMEBUFFER`.
    pub(super) fn bind(&self, fbo: u32) {
        // SAFETY: plain state setter on the current context.
        unsafe { (self.bind_framebuffer)(GL_FRAMEBUFFER, fbo) };
    }

    /// `glCheckFramebufferStatus` for the currently bound `GL_FRAMEBUFFER`.
    pub(super) fn status(&self) -> u32 {
        // SAFETY: the caller binds the FBO first; the query has no other
        // precondition.
        unsafe { (self.check_framebuffer_status)(GL_FRAMEBUFFER) }
    }

    /// Delete one framebuffer name.
    pub(super) fn delete(&self, fbo: u32) {
        // SAFETY: `fbo` was created on the current context; C reads one u32.
        unsafe { (self.delete_framebuffers)(1, &fbo) };
    }
}

pub(super) fn clear_gl_errors() {
    for _ in 0..MAX_DRAINED_ERRORS {
        // SAFETY: glGetError has no preconditions; the context is current.
        if unsafe { glGetError() } == GL_NO_ERROR {
            return;
        }
    }
}

pub(super) fn check_gl_error(step: &str) -> Result<(), String> {
    // SAFETY: glGetError has no preconditions; the context is current.
    let code = unsafe { glGetError() };
    if code == GL_NO_ERROR {
        Ok(())
    } else {
        Err(format!("{step} failed (GL error 0x{code:X})"))
    }
}

/// Create the RGBA8 texture + FBO pair and verify completeness. A partial
/// failure leaves the objects to the context teardown (deleting the context
/// reclaims every GL object it owns).
pub(super) fn create_target(
    fbo_api: &FboApi,
    width: u32,
    height: u32,
) -> Result<(u32, u32), String> {
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
