//! WGL_NV_DX_interop2 bridge: the GL FBO texture and a D3D11 texture become
//! one surface, so the video frame mpv rendered in OpenGL can be consumed by
//! Direct3D without any CPU copy.
//!
//! Reference: Khronos `WGL_NV_DX_interop` / `WGL_NV_DX_interop2` specs
//! (registry.khronos.org/OpenGL/extensions/NV/). The rules this module obeys:
//! - All `wglDX*` entry points are extension functions: resolved through
//!   `wglGetProcAddress` (opengl32 has no static export for them).
//! - `wglDXOpenDeviceNV` links a D3D10/11 device to the CURRENT GL context;
//!   everything here therefore runs on the render thread with the context
//!   current.
//! - The D3D resource must be created with `D3D11_USAGE_DEFAULT` (spec Table
//!   `wgl.restrictions`); enforced by `Composition::create_d3d_texture`.
//! - Lock/Unlock are the synchronization points (the spec's own sample loop
//!   locks BEFORE GL renders and unlocks before Direct3D reads). No `glFinish`
//!   is needed: "The Lock/Unlock calls serve as synchronization points between
//!   OpenGL and DirectX." The per-frame order here is therefore:
//!   lock -> GL renders -> unlock -> Direct3D copies.
//! - Access `WGL_ACCESS_READ_WRITE_NV`: GL renders into the texture (write)
//!   and the FBO readback test may read it; READ_ONLY would make GL writes
//!   undefined per the spec.
//! - A missing extension/function is a typed `Unavailable` error naming
//!   NV_DX_interop2 — the engine fails creation with it; there is no silent
//!   fallback (a non-NVIDIA fallback is a Main Agent decision, see the S3
//!   report).
//!
//! BOOLEAN returns: wglext.h declares the query calls as `BOOLEAN` (1 byte),
//! so the function-pointer types below return `u8`, not `i32`.

use std::ffi::{c_void, CStr};
use std::sync::Arc;

use windows_sys::Win32::Foundation::GetLastError;

use super::gl::{is_wgl_failure, wglGetProcAddress, GL_TEXTURE_2D};

/// `WGL_ACCESS_READ_WRITE_NV` (wglext.h): GL may read and write the resource
/// while locked. GL writes it every frame (mpv renders into the FBO) and the
/// readback path may read it.
const WGL_ACCESS_READ_WRITE_NV: u32 = 0x0001;

/// Every failure mode of the interop bridge.
#[derive(Debug)]
pub(crate) enum InteropError {
    /// NV_DX_interop2 (or the driver's `wglDX*` entry points) is not there.
    /// Carries the exact symbol so a non-NVIDIA machine is diagnosable.
    Unavailable { symbol: &'static str, detail: String },
    /// A `wglDX*` call failed; `code` is the Win32 last-error value.
    Call { step: &'static str, code: u32 },
}

impl std::fmt::Display for InteropError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InteropError::Unavailable { symbol, detail } => write!(
                formatter,
                "NV_DX_interop2 unavailable (requires NVIDIA GPU): {symbol} could not be resolved ({detail})"
            ),
            InteropError::Call { step, code } => {
                write!(formatter, "libmpv interop: {step} failed (win32 error {code})")
            }
        }
    }
}

impl std::error::Error for InteropError {}

fn last_error() -> u32 {
    // SAFETY: reading this thread's last-error value; no preconditions.
    unsafe { GetLastError() }
}

type PfnOpenDevice = unsafe extern "system" fn(*mut c_void) -> *mut c_void;
type PfnCloseDevice = unsafe extern "system" fn(*mut c_void) -> u8;
type PfnRegisterObject =
    unsafe extern "system" fn(*mut c_void, *mut c_void, u32, u32, u32) -> *mut c_void;
type PfnUnregisterObject = unsafe extern "system" fn(*mut c_void, *mut c_void) -> u8;
type PfnLockObjects = unsafe extern "system" fn(*mut c_void, i32, *const *mut c_void) -> u8;
type PfnUnlockObjects = unsafe extern "system" fn(*mut c_void, i32, *const *mut c_void) -> u8;

/// The `wglDX*` entry points of the current GL context's driver. Resolved
/// once per render thread (WGL function pointers are context-specific).
pub(crate) struct InteropApi {
    open_device: PfnOpenDevice,
    close_device: PfnCloseDevice,
    register_object: PfnRegisterObject,
    unregister_object: PfnUnregisterObject,
    lock_objects: PfnLockObjects,
    unlock_objects: PfnUnlockObjects,
}

impl InteropApi {
    /// Resolve every `wglDX*` symbol through `wglGetProcAddress`; the first
    /// missing one is a typed `Unavailable` error. Called with the GL context
    /// current (render thread).
    pub(crate) fn load() -> Result<Arc<Self>, InteropError> {
        fn load<T: Copy>(name: &'static CStr) -> Result<T, InteropError> {
            // SAFETY: the GL context is current on this thread (render thread
            // invariant); NUL-terminated name; wglGetProcAddress has no other
            // preconditions.
            let proc = unsafe { wglGetProcAddress(name.as_ptr()) };
            if is_wgl_failure(proc) {
                return Err(InteropError::Unavailable {
                    symbol: name.to_str().unwrap_or("wglDX?"),
                    detail: format!("wglGetProcAddress returned null (win32 error {})", last_error()),
                });
            }
            // SAFETY: the sentinel/NULL check above rejects every non-pointer
            // return; T is the exact wglext.h signature of this entry point.
            Ok(unsafe { std::mem::transmute_copy::<*const c_void, T>(&proc) })
        }
        Ok(Arc::new(Self {
            open_device: load(c"wglDXOpenDeviceNV")?,
            close_device: load(c"wglDXCloseDeviceNV")?,
            register_object: load(c"wglDXRegisterObjectNV")?,
            unregister_object: load(c"wglDXUnregisterObjectNV")?,
            lock_objects: load(c"wglDXLockObjectsNV")?,
            unlock_objects: load(c"wglDXUnlockObjectsNV")?,
        }))
    }
}

/// An open interop device (one per D3D device). Closed on drop.
pub(crate) struct InteropDevice {
    api: Arc<InteropApi>,
    handle: *mut c_void,
}

impl InteropDevice {
    /// `wglDXOpenDeviceNV`: link the GL context (current) with the D3D11
    /// device. A NULL return is the non-NVIDIA / extension-missing case.
    pub(crate) fn open(
        api: Arc<InteropApi>,
        d3d_device: *mut c_void,
    ) -> Result<Self, InteropError> {
        // SAFETY: d3d_device is the live ID3D11Device of the render thread's
        // Composition; the GL context is current on this thread.
        let handle = unsafe { (api.open_device)(d3d_device) };
        if handle.is_null() {
            return Err(InteropError::Unavailable {
                symbol: "wglDXOpenDeviceNV",
                detail: format!(
                    "returned NULL (win32 error {}) — the D3D11 device could not be linked to the GL context",
                    last_error()
                ),
            });
        }
        Ok(Self { api, handle })
    }

    /// `wglDXRegisterObjectNV`: bind the GL texture object to the D3D11
    /// texture (same size and format by construction).
    pub(crate) fn register(
        &self,
        gl_texture: u32,
        d3d_texture: *mut c_void,
    ) -> Result<InteropObject, InteropError> {
        // SAFETY: both objects are live and both live on this (render) thread;
        // GL_TEXTURE_2D is the registered type for ID3D11Texture2D.
        let object = unsafe {
            (self.api.register_object)(
                self.handle,
                d3d_texture,
                gl_texture,
                GL_TEXTURE_2D,
                WGL_ACCESS_READ_WRITE_NV,
            )
        };
        if object.is_null() {
            return Err(InteropError::Call {
                step: "wglDXRegisterObjectNV",
                code: last_error(),
            });
        }
        Ok(InteropObject {
            api: Arc::clone(&self.api),
            device: self.handle,
            object,
            registered: true,
        })
    }
}

impl Drop for InteropDevice {
    fn drop(&mut self) {
        // SAFETY: the handle came from wglDXOpenDeviceNV on this thread and is
        // closed exactly once (Drop runs once).
        let ok = unsafe { (self.api.close_device)(self.handle) };
        if ok == 0 {
            log::warn!(
                "[player] wglDXCloseDeviceNV failed (win32 error {})",
                last_error()
            );
        }
    }
}

/// One registered GL texture <-> D3D11 texture pair. `lock`/`unlock` bracket
/// every GL access to the shared storage (mpv render, FBO readback).
pub(crate) struct InteropObject {
    api: Arc<InteropApi>,
    device: *mut c_void,
    object: *mut c_void,
    registered: bool,
}

impl InteropObject {
    /// `wglDXLockObjectsNV`: GL takes ownership; D3D must not touch the
    /// resource until `unlock`.
    pub(crate) fn lock(&self) -> Result<(), InteropError> {
        if !self.registered {
            return Err(InteropError::Call { step: "lock (unregistered object)", code: 0 });
        }
        // SAFETY: device handle and object handle are live; the count-1 array
        // borrows `self.object` for the duration of the call.
        let ok = unsafe { (self.api.lock_objects)(self.device, 1, &self.object) };
        if ok == 0 {
            return Err(InteropError::Call { step: "wglDXLockObjectsNV", code: last_error() });
        }
        Ok(())
    }

    /// `wglDXUnlockObjectsNV`: GL's rendering is flushed and D3D takes over
    /// (this is the spec's synchronization point; no glFinish needed).
    pub(crate) fn unlock(&self) -> Result<(), InteropError> {
        if !self.registered {
            return Err(InteropError::Call { step: "unlock (unregistered object)", code: 0 });
        }
        // SAFETY: as in `lock`, same live handles.
        let ok = unsafe { (self.api.unlock_objects)(self.device, 1, &self.object) };
        if ok == 0 {
            return Err(InteropError::Call { step: "wglDXUnlockObjectsNV", code: last_error() });
        }
        Ok(())
    }

    /// `wglDXUnregisterObjectNV`; idempotent (a second call is a no-op). Must
    /// run BEFORE the GL texture storage is reallocated and before the D3D
    /// texture is released.
    pub(crate) fn unregister(&mut self) {
        if !self.registered {
            return;
        }
        // SAFETY: live device + object handles on this thread; the object is
        // unregistered exactly once (registered flips below).
        let ok = unsafe { (self.api.unregister_object)(self.device, self.object) };
        self.registered = false;
        if ok == 0 {
            log::warn!(
                "[player] wglDXUnregisterObjectNV failed (win32 error {})",
                last_error()
            );
        }
    }

    pub(crate) fn is_registered(&self) -> bool {
        self.registered
    }
}

impl Drop for InteropObject {
    fn drop(&mut self) {
        self.unregister();
    }
}
