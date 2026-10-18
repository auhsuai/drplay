use super::composition::Composition;
use super::gl::GlContext;
use super::interop::{InteropApi, InteropDevice, InteropObject};

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
pub(super) struct PresentPipeline {
    object: Option<InteropObject>,
    device: InteropDevice,
    pub(super) composition: Composition,
}

impl PresentPipeline {
    /// Create the composition stack + open the interop device + register the
    /// GL FBO texture against a fresh D3D11 texture. Any failure fails engine
    /// creation (typed error up the chain; no silent fallback).
    pub(super) fn new(
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
    pub(super) fn can_present(&self) -> bool {
        let (_, _, w, h) = self.composition.rect();
        w > 0
            && h > 0
            && self.composition.visible()
            && self.object.as_ref().map(InteropObject::is_registered).unwrap_or(false)
    }

    pub(super) fn lock(&self) -> Result<(), String> {
        match self.object.as_ref() {
            Some(object) => {
                object.lock().map_err(|e| e.to_string())?;
                Ok(())
            }
            None => Err("interop object is not registered".to_string()),
        }
    }

    pub(super) fn unlock(&self) -> Result<(), String> {
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
    pub(super) fn refresh_size(
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

    pub(super) fn set_rect(&mut self, x: i32, y: i32, w: u32, h: u32) -> Result<(), String> {
        self.composition.set_rect(x, y, w, h).map_err(|e| e.to_string())
    }

    pub(super) fn set_visible(&mut self, visible: bool) -> Result<(), String> {
        self.composition.set_visible(visible).map_err(|e| e.to_string())
    }

    pub(super) fn present(&self) -> Result<(), String> {
        self.composition.present().map_err(|e| e.to_string())
    }
}

/// Outcome of one update cycle: `rendered` = mpv produced a frame (even a
/// skipped one), `presented` = that frame reached DirectComposition.
#[derive(Clone, Copy, Default)]
pub(super) struct PumpOutcome {
    pub(super) rendered: bool,
    pub(super) presented: bool,
}
