//! D3D11 + DirectComposition presentation side of the S3 composition bridge
//! (VIDEO-RENDER-ARCHITECTURE-ADR.md, slices S3/S4).
//!
//! Ownership (spec §48): every object here is created, used and destroyed on
//! the RENDER THREAD only — D3D11 device/context, the DirectComposition
//! device/target/visual/transform/surface, and (via the pipeline in
//! render/mod.rs) the interop device and registration. The Tauri thread never
//! touches any of it; it only writes rect/visibility requests.
//!
//! Geometry model (documented because it is the part easiest to get wrong):
//! - The frontend rect is PHYSICAL pixels relative to the window's client area.
//! - DirectComposition speaks DIPs: `dip = physical / (GetDpiForWindow / 96)`.
//!   No rounding: DComp takes float offsets/scales and rounding would quantize
//!   every rect to whole DIPs (visible jitter while dragging on a scaled monitor).
//! - DirectComposition maps surface content 1 pixel = 1 DIP, so the visual is
//!   also SCALED by `1 / scale` to display the physical-pixel content at the
//!   right physical size.
//! - mpv renders into the GL FBO top-down (row 0 = TOP, matching D3D/DComp),
//!   so NO vertical flip is applied. The visual offset is the rect origin
//!   scaled to DIP:
//!
//!       offset_dip = (x / scale, y / scale)
//!       displayed rect = [x/s, x/s + w/s] x [y/s, y/s + h/s]
//!
//!   A 640x360 video at rect (100,50) with scale 1.0 therefore has the visual
//!   offset (100, 50) — the top of the rect — and displays upright.
//!
//! Pixel formats: GL_RGBA8 (memory R,G,B,A on little-endian) is paired with
//! DXGI_FORMAT_R8G8B8A8_UNORM for the interop texture and the DComp surface,
//! so no channel swizzle is needed anywhere; CopyResource requires the source
//! and destination formats to match exactly, which they do. Alpha mode is
//! DXGI_ALPHA_MODE_IGNORE (the video occupies its rect opaquely; the WebView2
//! layer composites ABOVE this visual, so the visual itself needs no alpha).

use std::ffi::c_void;

use windows::core::{Interface, IUnknown};
use windows::Win32::Foundation::{HMODULE, HWND, POINT, RPC_E_CHANGED_MODE, S_FALSE, S_OK};
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_10_0, D3D_FEATURE_LEVEL_10_1,
    D3D_FEATURE_LEVEL_11_0,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11RenderTargetView,
    ID3D11Texture2D, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC,
    D3D11_USAGE_DEFAULT,
};
use windows::Win32::Graphics::DirectComposition::{
    DCompositionCreateDevice3, IDCompositionDesktopDevice, IDCompositionDevice2,
    IDCompositionScaleTransform, IDCompositionSurface, IDCompositionTarget, IDCompositionVisual,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_ALPHA_MODE_IGNORE, DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::{IDXGIAdapter, IDXGIDevice};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
use windows::Win32::UI::HiDpi::GetDpiForWindow;

/// The DIP base DPI every DirectComposition conversion is relative to
/// (`GetDpiForWindow` returns 96 for a 100% monitor).
pub(crate) const DIP_BASE_DPI: f32 = 96.0;

/// Every failure path of the composition stack, with the exact step that
/// failed. Nothing here falls back silently: an engine that cannot compose
/// fails creation with this error.
#[derive(Debug)]
pub(crate) enum CompositionError {
    /// COM could not be initialized on the render thread.
    Com { detail: String },
    /// One D3D11/DComp call failed; `detail` carries the HRESULT text.
    Call { step: &'static str, detail: String },
}

impl std::fmt::Display for CompositionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CompositionError::Com { detail } => {
                write!(formatter, "libmpv composition: COM initialization failed: {detail}")
            }
            CompositionError::Call { step, detail } => {
                write!(formatter, "libmpv composition: {step} failed: {detail}")
            }
        }
    }
}

impl std::error::Error for CompositionError {}

/// Convert a physical-pixel distance to DIP.
///
/// Kept as a plain division with NO rounding on purpose: DirectComposition
/// offsets/scales are floats, so rounding here would quantize every rect to
/// whole DIPs (visible jitter while dragging on a scaled monitor). A broken
/// (zero/negative/NaN) scale degrades to identity — the caller logs the
/// invalid DPI — so no NaN ever reaches DComposition.
pub(crate) fn convert_physical_to_dip(physical: f32, scale: f32) -> f32 {
    if scale.is_finite() && scale > 0.0 {
        physical / scale
    } else {
        physical
    }
}

/// The visual offsets (DIP) that place the content so that the displayed
/// rect is `(x, y, w, h)` (see the module docs for the derivation).
pub(crate) fn visual_offset_dip(x: i32, y: i32, scale: f32) -> (f32, f32) {
    (
        convert_physical_to_dip(x as f32, scale),
        convert_physical_to_dip(y as f32, scale),
    )
}

/// The DPI scale of `hwnd` (`GetDpiForWindow / 96`). A failed query (invalid
/// window, pre-1607 OS) logs and assumes 100% instead of producing a NaN.
pub(crate) fn window_dpi_scale(hwnd: HWND) -> f32 {
    // SAFETY: plain user32 query on any handle value; an invalid handle
    // returns 0 instead of failing.
    let dpi = unsafe { GetDpiForWindow(hwnd) };
    if dpi == 0 {
        log::warn!("[player] GetDpiForWindow failed; assuming {DIP_BASE_DPI} DPI");
        return 1.0;
    }
    dpi as f32 / DIP_BASE_DPI
}

fn call<T>(
    step: &'static str,
    result: windows::core::Result<T>,
) -> Result<T, CompositionError> {
    result.map_err(|error| CompositionError::Call { step, detail: format!("{error}") })
}

/// COM lifetime guard for the render thread. `CoInitializeEx` must run before
/// the DirectComposition device is created; only an actual initialization
/// (S_OK) is paired with `CoUninitialize` — S_FALSE means COM was already up
/// on this thread, and RPC_E_CHANGED_MODE means another component owns a
/// different apartment (DirectComposition does not require ours; continue).
struct ComApartment {
    uninitialize: bool,
}

impl ComApartment {
    fn acquire() -> Result<Self, CompositionError> {
        // SAFETY: plain COM initializer; no reserved argument.
        let result = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if result == S_OK {
            return Ok(Self { uninitialize: true });
        }
        if result == S_FALSE {
            return Ok(Self { uninitialize: false });
        }
        if result == RPC_E_CHANGED_MODE {
            log::warn!(
                "[player] COM already initialized in a different apartment; DirectComposition does not require this thread's apartment"
            );
            return Ok(Self { uninitialize: false });
        }
        Err(CompositionError::Com { detail: format!("CoInitializeEx returned 0x{:08X}", result.0 as u32) })
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        if self.uninitialize {
            // SAFETY: paired with the successful CoInitializeEx above, on the
            // same (render) thread.
            unsafe { CoUninitialize() };
        }
    }
}

/// The D3D11 device + DirectComposition target/visual/surface bound to the
/// main window with `topmost = false` (video sits BELOW the WebView2 child,
/// ADR "Candidate A"). Created, used and dropped on the render thread.
pub(crate) struct Composition {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    device2: IDCompositionDevice2,
    /// The target must stay alive for the visual tree to remain bound.
    _target: IDCompositionTarget,
    visual: IDCompositionVisual,
    scale_transform: IDCompositionScaleTransform,
    surface: IDCompositionSurface,
    /// Shared with the GL FBO texture via WGL_NV_DX_interop2. Replaced on
    /// every size change (unregister -> GL realloc -> new texture -> register,
    /// driven by the pipeline in render/mod.rs).
    interop_texture: Option<ID3D11Texture2D>,
    _com: ComApartment,
    hwnd: HWND,
    size: (u32, u32),
    rect: (i32, i32, u32, u32),
    dpi_scale: f32,
    offset_dip: (f32, f32),
    visible: bool,
}

impl Composition {
    /// Create the whole stack: COM -> D3D11 device/context -> DXGI device ->
    /// DComp device -> target(hwnd, topmost=FALSE) -> visual (with the
    /// physical->DIP scale transform) -> opaque surface. Starts hidden (no
    /// content) — the frontend
    /// decides visibility.
    pub(crate) fn create(hwnd: usize, width: u32, height: u32) -> Result<Self, CompositionError> {
        let com = ComApartment::acquire()?;
        let hwnd = HWND(hwnd as *mut c_void);
        let levels =
            [D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_1, D3D_FEATURE_LEVEL_10_0];
        let mut device: Option<ID3D11Device> = None;
        let mut context: Option<ID3D11DeviceContext> = None;
        // SAFETY: out-parameters are live locals; feature level array is a
        // slice. BGRA support is requested (standard for composition stacks);
        // the debug layer is deliberately NOT enabled (no debug runtime on end
        // user machines).
        call(
            "D3D11CreateDevice",
            unsafe {
                D3D11CreateDevice(
                    None::<&IDXGIAdapter>,
                    D3D_DRIVER_TYPE_HARDWARE,
                    HMODULE(std::ptr::null_mut()),
                    D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                    Some(&levels),
                    D3D11_SDK_VERSION,
                    Some(&mut device),
                    None,
                    Some(&mut context),
                )
            },
        )?;
        let device = device.ok_or(CompositionError::Call {
            step: "D3D11CreateDevice",
            detail: "no ID3D11Device returned".to_string(),
        })?;
        let context = context.ok_or(CompositionError::Call {
            step: "D3D11CreateDevice",
            detail: "no immediate context returned".to_string(),
        })?;
        let dxgi: IDXGIDevice = call("ID3D11Device -> IDXGIDevice", device.cast())?;
        let dxgi_unknown: IUnknown = call("IDXGIDevice -> IUnknown", dxgi.cast())?;
        let dcomp: IDCompositionDesktopDevice =
            call("DCompositionCreateDevice3", unsafe { DCompositionCreateDevice3(&dxgi_unknown) })?;
        let device2: IDCompositionDevice2 =
            call("desktop device -> IDCompositionDevice2", dcomp.cast())?;
        // topmost = FALSE is load-bearing (ADR Candidate A / spike evidence):
        // the visual tree renders BELOW the WebView2 child window.
        let target = call("CreateTargetForHwnd", unsafe { dcomp.CreateTargetForHwnd(hwnd, false) })?;
        let visual2 = call("CreateVisual", unsafe { device2.CreateVisual() })?;
        let visual: IDCompositionVisual = call("visual -> IDCompositionVisual", visual2.cast())?;
        call("visual SetRoot", unsafe { target.SetRoot(&visual) })?;
        let scale_transform = call("CreateScaleTransform", unsafe { device2.CreateScaleTransform() })?;
        // Physical->DIP content scale (no flip: the FBO is top-down); the
        // center defaults to the content origin, set explicitly so the
        // derivation in the module docs is pinned rather than assumed.
        for (step, result) in [
            ("SetScaleX2", unsafe { scale_transform.SetScaleX2(1.0) }),
            ("SetScaleY2", unsafe { scale_transform.SetScaleY2(1.0) }),
            ("SetCenterX2", unsafe { scale_transform.SetCenterX2(0.0) }),
            ("SetCenterY2", unsafe { scale_transform.SetCenterY2(0.0) }),
        ] {
            call(step, result)?;
        }
        call("visual SetTransform", unsafe { visual.SetTransform(&scale_transform) })?;
        let surface = call(
            "CreateSurface",
            unsafe {
                device2.CreateSurface(
                    width,
                    height,
                    DXGI_FORMAT_R8G8B8A8_UNORM,
                    DXGI_ALPHA_MODE_IGNORE,
                )
            },
        )?;
        call("SetContent(null)", unsafe { visual.SetContent(None::<&IUnknown>) })?;
        call("Commit", unsafe { device2.Commit() })?;
        Ok(Self {
            device,
            context,
            device2,
            _target: target,
            visual,
            scale_transform,
            surface,
            interop_texture: None,
            _com: com,
            hwnd,
            size: (width, height),
            rect: (0, 0, 0, 0),
            dpi_scale: window_dpi_scale(hwnd),
            offset_dip: (0.0, 0.0),
            visible: false,
        })
    }

    /// Raw `ID3D11Device*` for `wglDXOpenDeviceNV`.
    pub(crate) fn device_raw(&self) -> *mut c_void {
        self.device.as_raw()
    }

    /// Create the D3D11 texture the GL FBO texture is registered against
    /// (D3D11_USAGE_DEFAULT is the one usage WGL_NV_DX_interop allows).
    pub(crate) fn create_d3d_texture(
        &self,
        width: u32,
        height: u32,
    ) -> Result<ID3D11Texture2D, CompositionError> {
        let description = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_R8G8B8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: 0,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let mut texture: Option<ID3D11Texture2D> = None;
        call(
            "CreateTexture2D",
            // SAFETY: description is a live local; the out-parameter is owned here.
            unsafe { self.device.CreateTexture2D(&description, None, Some(&mut texture)) },
        )?;
        texture.ok_or(CompositionError::Call {
            step: "CreateTexture2D",
            detail: "no ID3D11Texture2D returned".to_string(),
        })
    }

    /// (Re)create the interop texture for a size change. The old texture is
    /// released here; the caller MUST have unregistered the interop object
    /// first (the pipeline in render/mod.rs owns that order).
    pub(crate) fn replace_interop_texture(
        &mut self,
        width: u32,
        height: u32,
    ) -> Result<(), CompositionError> {
        let texture = self.create_d3d_texture(width, height)?;
        self.interop_texture = Some(texture);
        Ok(())
    }

    /// Raw `ID3D11Texture2D*` of the current interop texture (registered with
    /// the GL texture by the pipeline).
    pub(crate) fn interop_texture_raw(&self) -> *mut c_void {
        self.interop_texture.as_ref().map(Interface::as_raw).unwrap_or(std::ptr::null_mut())
    }

    /// BeginDraw -> CopyResource(interop texture -> surface texture) ->
    /// EndDraw -> Commit. The DComp surface pixels are the whole frame.
    ///
    /// MIGRATION-ONLY (S7): with `DRPLAY_DIAG_SOLID=1` the video copy is
    /// SKIPPED and the surface is cleared magenta instead. That is the only
    /// way to separate "the webview is painting over the rect" from "the engine
    /// has no frame": magenta on screen proves the page really is alpha=0
    /// there, so a still-black rect is an engine-side problem.
    pub(crate) fn present(&self) -> Result<(), CompositionError> {
        let Some(source) = self.interop_texture.as_ref() else {
            return Err(CompositionError::Call {
                step: "present",
                detail: "no interop texture".to_string(),
            });
        };
        let mut update_offset = POINT { x: 0, y: 0 };
        let update_texture: ID3D11Texture2D = call(
            "BeginDraw",
            // SAFETY: None = full-surface update; update_offset is a live local.
            unsafe { self.surface.BeginDraw(None, &mut update_offset) },
        )?;
        if super::diag_solid_fill() {
            self.clear_magenta(&update_texture)?;
        } else {
            // CopyResource has no failure return; a removed device surfaces at
            // EndDraw/Commit below.
            // SAFETY: both textures are live ID3D11 textures of identical size and
            // format; CopyResource is documented for exactly this pair.
            unsafe { self.context.CopyResource(&update_texture, source) };
        }
        call("EndDraw", unsafe { self.surface.EndDraw() })?;
        call("Commit", unsafe { self.device2.Commit() })?;
        Ok(())
    }

    /// Clear the surface texture to the diagnostic magenta. A NULL RTV
    /// descriptor is the documented single-mip form of an ID3D11Texture2D.
    fn clear_magenta(&self, surface_texture: &ID3D11Texture2D) -> Result<(), CompositionError> {
        let mut target: Option<ID3D11RenderTargetView> = None;
        call(
            "CreateRenderTargetView(diag)",
            // SAFETY: the texture is the live BeginDraw result; the out-parameter
            // is owned here.
            unsafe { self.device.CreateRenderTargetView(surface_texture, None, Some(&mut target)) },
        )?;
        let target = target.ok_or(CompositionError::Call {
            step: "CreateRenderTargetView(diag)",
            detail: "no ID3D11RenderTargetView returned".to_string(),
        })?;
        // SAFETY: the context and the view are both live and owned by this
        // render thread; the color slice is the documented 4-float RGBA.
        unsafe { self.context.ClearRenderTargetView(&target, &super::DIAG_SOLID_COLOR) };
        Ok(())
    }

    /// Apply a client-area rect (physical px). Size changes recreate the DComp
    /// surface (a regular IDCompositionSurface cannot be resized); every call
    /// re-applies the DIP scale + offsets and commits.
    pub(crate) fn set_rect(
        &mut self,
        x: i32,
        y: i32,
        w: u32,
        h: u32,
    ) -> Result<(), CompositionError> {
        self.rect = (x, y, w, h);
        if w == 0 || h == 0 {
            // Collapsed rect (minimized window / pre-layout read): keep the
            // surface as-is; the pipeline skips presenting until a real size
            // returns.
            return Ok(());
        }
        if (w, h) != self.size {
            self.recreate_surface(w, h)?;
        }
        self.dpi_scale = window_dpi_scale(self.hwnd);
        let scale = self.dpi_scale;
        let inverse = 1.0 / scale;
        let (offset_x, offset_y) = visual_offset_dip(x, y, scale);
        for (step, result) in [
            ("SetScaleX2", unsafe { self.scale_transform.SetScaleX2(inverse) }),
            ("SetScaleY2", unsafe { self.scale_transform.SetScaleY2(inverse) }),
            ("SetOffsetX2", unsafe { self.visual.SetOffsetX2(offset_x) }),
            ("SetOffsetY2", unsafe { self.visual.SetOffsetY2(offset_y) }),
        ] {
            call(step, result)?;
        }
        call("Commit", unsafe { self.device2.Commit() })?;
        self.offset_dip = (offset_x, offset_y);
        Ok(())
    }

    /// Show/hide the content (`SetContent(surface | NULL)`).
    pub(crate) fn set_visible(&mut self, visible: bool) -> Result<(), CompositionError> {
        if visible == self.visible {
            return Ok(());
        }
        if visible {
            call("SetContent(surface)", unsafe { self.visual.SetContent(&self.surface) })?;
        } else {
            call("SetContent(null)", unsafe { self.visual.SetContent(None::<&IUnknown>) })?;
        }
        call("Commit", unsafe { self.device2.Commit() })?;
        self.visible = visible;
        log::info!("[player] composition content visible={visible}");
        Ok(())
    }

    fn recreate_surface(&mut self, width: u32, height: u32) -> Result<(), CompositionError> {
        let surface = call(
            "CreateSurface(resize)",
            unsafe {
                self.device2.CreateSurface(
                    width,
                    height,
                    DXGI_FORMAT_R8G8B8A8_UNORM,
                    DXGI_ALPHA_MODE_IGNORE,
                )
            },
        )?;
        if self.visible {
            call("SetContent(surface)", unsafe { self.visual.SetContent(&surface) })?;
            call("Commit", unsafe { self.device2.Commit() })?;
        }
        self.surface = surface;
        self.size = (width, height);
        log::info!("[player] composition surface recreated {width}x{height}");
        Ok(())
    }

    /// Frame the frontend asked for (physical px; zero size = collapsed).
    pub(crate) fn rect(&self) -> (i32, i32, u32, u32) {
        self.rect
    }

    /// Surface size currently allocated (physical px).
    pub(crate) fn size(&self) -> (u32, u32) {
        self.size
    }

    pub(crate) fn visible(&self) -> bool {
        self.visible
    }

    pub(crate) fn dpi_scale(&self) -> f32 {
        self.dpi_scale
    }

    #[allow(dead_code)] // read-only diagnostic accessor (S3 tests / diagnostics)
    pub(crate) fn offset_dip(&self) -> (f32, f32) {
        self.offset_dip
    }

    /// The logical visual rect in DIP (what the scale display actually
    /// occupies): `(x, y, w, h) / scale`.
    pub(crate) fn visual_rect_dip(&self) -> (f32, f32, f32, f32) {
        let (x, y, w, h) = self.rect;
        let scale = self.dpi_scale;
        (
            convert_physical_to_dip(x as f32, scale),
            convert_physical_to_dip(y as f32, scale),
            convert_physical_to_dip(w as f32, scale),
            convert_physical_to_dip(h as f32, scale),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EPSILON: f32 = 1e-4;

    fn assert_close(actual: f32, expected: f32) {
        assert!(
            (actual - expected).abs() < EPSILON,
            "expected {expected}, got {actual}"
        );
    }

    /// S3-1: the four scales of the target matrix (100% / 125% / 150% / 200%).
    #[test]
    fn physical_to_dip_covers_the_target_scales() {
        assert_close(convert_physical_to_dip(96.0, 1.0), 96.0);
        assert_close(convert_physical_to_dip(125.0, 1.25), 100.0);
        assert_close(convert_physical_to_dip(150.0, 1.5), 100.0);
        assert_close(convert_physical_to_dip(200.0, 2.0), 100.0);
        // No rounding: sub-DIP precision survives (jitter-free dragging).
        assert_close(convert_physical_to_dip(101.0, 2.0), 50.5);
    }

    /// A non-positive/non-finite scale must not produce NaN/inf offsets: the
    /// conversion degrades to identity (the caller logs the DPI failure).
    #[test]
    fn physical_to_dip_degrades_to_identity_for_a_broken_scale() {
        assert_close(convert_physical_to_dip(123.0, 0.0), 123.0);
        assert_close(convert_physical_to_dip(123.0, -1.0), 123.0);
        assert_close(convert_physical_to_dip(123.0, f32::NAN), 123.0);
    }

    /// S3-6: an offset rect on every scale (100% / 125% / 150% / 200%). With
    /// no flip, the offset is exactly the rect origin in DIP.
    #[test]
    fn visual_offset_is_the_rect_origin_on_every_scale() {
        assert_eq!(visual_offset_dip(100, 50, 1.0), (100.0, 50.0));
        assert_close(visual_offset_dip(100, 50, 1.25).0, 80.0);
        assert_close(visual_offset_dip(100, 50, 1.25).1, 40.0);
        assert_close(visual_offset_dip(100, 50, 1.5).0, 66.66667);
        assert_close(visual_offset_dip(100, 50, 1.5).1, 33.33333);
        assert_close(visual_offset_dip(100, 50, 2.0).0, 50.0);
        assert_close(visual_offset_dip(100, 50, 2.0).1, 25.0);
    }

    /// A zero-size rect (collapsed player area) must not produce a NaN offset;
    /// it maps to the rect origin and the pump skips presenting it.
    #[test]
    fn visual_offset_handles_a_zero_size_rect() {
        assert_eq!(visual_offset_dip(10, 20, 1.0), (10.0, 20.0));
        assert_close(visual_offset_dip(10, 20, 2.0).0, 5.0);
        assert_close(visual_offset_dip(10, 20, 2.0).1, 10.0);
    }

    /// The displayed rect is the physical rect / scale on every scale — this
    /// is what S4's screenshots will compare against.
    #[test]
    fn the_displayed_rect_is_the_physical_rect_in_dip() {
        for scale in [1.0_f32, 1.25, 1.5, 2.0] {
            let (offset_x, offset_y) = visual_offset_dip(100, 50, scale);
            let (x, y, w, h) = (
                convert_physical_to_dip(100.0, scale),
                convert_physical_to_dip(50.0, scale),
                convert_physical_to_dip(640.0, scale),
                convert_physical_to_dip(360.0, scale),
            );
            // No flip: the offset IS the rect origin and the content spans
            // [offset, offset + (w, h)].
            assert_close(offset_x, x);
            assert_close(offset_y, y);
            assert_close(offset_x + w, convert_physical_to_dip(740.0, scale));
            assert_close(offset_y + h, convert_physical_to_dip(410.0, scale));
        }
    }
}
