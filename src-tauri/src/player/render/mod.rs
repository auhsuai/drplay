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


mod api;
mod composition;
mod gl;
mod interop;
mod pipeline;
mod shared;
mod surface;
mod thread;

#[cfg(test)]
mod tests;

use std::time::Duration;

pub(crate) use shared::RenderHost;
pub(crate) use surface::RenderSurface;

#[cfg(test)]
pub(crate) use api::{MpvOpenglFbo, MpvOpenglInitParams, MpvRenderParam};
#[cfg(test)]
pub(crate) use shared::PixelSample;
#[cfg(test)]
pub(crate) use surface::RENDER_THREAD_NAME;
#[cfg(test)]
pub(crate) use thread::requests::needs_size_sync;

/// Initial FBO/texture size. The first real resize arrives from the surface
/// rect pipeline in S3; until then this is the headless target size.
pub(crate) const RENDER_INITIAL_WIDTH: u32 = 1280;
pub(crate) const RENDER_INITIAL_HEIGHT: u32 = 720;

/// Bound for the render context to become ready during engine setup.
pub(crate) const RENDER_READY_TIMEOUT: Duration = Duration::from_secs(5);

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
