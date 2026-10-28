//! Physical-pixel to DIP geometry for the S3 composition bridge
//! (see `composition.rs` for the D3D11/DirectComposition side).
//!
//! Geometry model (documented because it is the part easiest to get wrong):
//! - The frontend rect is PHYSICAL pixels relative to the window's client area.
//! - DirectComposition speaks DIPs: `dip = physical / (window_dpi / 96)`.
//!   No rounding: DComp takes float offsets/scales and rounding would quantize
//!   every rect to whole DIPs (visible jitter while dragging on a scaled monitor).
//! - DirectComposition maps surface content 1 pixel = 1 DIP, so the visual is
//!   also SCALED by `1 / scale` to display the physical-pixel content at the
//!   right physical size.
//! - mpv renders into the GL FBO top-down (row 0 = TOP, matching D3D/DComp),
//!   so NO vertical flip is applied. The visual offset is the rect origin
//!   scaled to DIP:
//!
//!   ```text
//!   offset_dip = (x / scale, y / scale)
//!   displayed rect = [x/s, x/s + w/s] x [y/s, y/s + h/s]
//!   ```
//!
//!   A 640x360 video at rect (100,50) with scale 1.0 therefore has the visual
//!   offset (100, 50) — the top of the rect — and displays upright.

/// Convert a physical-pixel distance to DIP.
///
/// Kept as a plain division with NO rounding on purpose: DirectComposition
/// offsets/scales are floats, so rounding here would quantize every rect to
/// whole DIPs (visible jitter while dragging on a scaled monitor). A broken
/// (zero/negative/NaN) scale degrades to identity — the caller logs the
/// invalid DPI — so no NaN ever reaches DComposition.
pub(super) fn convert_physical_to_dip(physical: f32, scale: f32) -> f32 {
    if scale.is_finite() && scale > 0.0 {
        physical / scale
    } else {
        physical
    }
}

/// The visual offsets (DIP) that place the content so that the displayed
/// rect is `(x, y, w, h)` (see the module docs for the derivation).
pub(super) fn visual_offset_dip(x: i32, y: i32, scale: f32) -> (f32, f32) {
    (
        convert_physical_to_dip(x as f32, scale),
        convert_physical_to_dip(y as f32, scale),
    )
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
