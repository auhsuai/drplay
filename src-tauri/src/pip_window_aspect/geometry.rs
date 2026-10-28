//! The pure rectangle math behind the PiP aspect lock.
//!
//! No Win32 types, no window handles, no global state: `constrain_rect` is a
//! total function of `(rect, edge, aspect)`, so unit-testable without a
//! window. `win32` owns the WndProc that calls it.

/// The eight `wParam` values `WM_SIZING` documents, mirrored here as plain
/// numbers so the rect math (and its tests) carries no Win32 dependency.
/// They are frozen Win32 ABI values; the windows-only test
/// `local_edges_match_win32` pins them against `windows-sys`.
pub(crate) const WMSZ_LEFT: u32 = 1;
pub(crate) const WMSZ_RIGHT: u32 = 2;
pub(crate) const WMSZ_TOP: u32 = 3;
pub(crate) const WMSZ_TOPLEFT: u32 = 4;
pub(crate) const WMSZ_TOPRIGHT: u32 = 5;
pub(crate) const WMSZ_BOTTOM: u32 = 6;
pub(crate) const WMSZ_BOTTOMLEFT: u32 = 7;
pub(crate) const WMSZ_BOTTOMRIGHT: u32 = 8;

/// A window rectangle in PHYSICAL pixels, the unit `WM_SIZING` works in (the
/// coordinates are already DPI-scaled by the time a window procedure sees
/// them). Deliberately not a Win32 type: `constrain_rect` stays testable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RectI {
    pub(crate) left: i32,
    pub(crate) top: i32,
    pub(crate) right: i32,
    pub(crate) bottom: i32,
}

impl RectI {
    /// `(width, height)` as i64 so a pathological rect cannot overflow the
    /// subtraction before it is clamped.
    fn size(self) -> (i64, i64) {
        (
            self.right as i64 - self.left as i64,
            self.bottom as i64 - self.top as i64,
        )
    }
}

/// Round a computed dimension to whole pixels and keep it inside
/// `[1, i32::MAX]`. NaN saturates to 0 through the `as i64` cast and then
/// clamps to 1, so a non-finite intermediate can never produce a
/// zero/negative dimension.
fn dimension(value: f64) -> i64 {
    (value.round() as i64).clamp(1, i32::MAX as i64)
}

/// Clamp an i64 coordinate back into i32 without wrapping around.
fn coordinate(value: i64) -> i32 {
    value.clamp(i32::MIN as i64, i32::MAX as i64) as i32
}

/// Total fallback for the pathological case where an anchor sits at the very
/// edge of the i32 coordinate space and the clamped far edge lands ON it: the
/// rectangle must still enclose at least one pixel, moving the far edge if it
/// can and the anchor if it cannot. Unreachable for any real screen, but it
/// is what makes "never a zero/negative rect" unconditional.
fn normalise(mut rect: RectI) -> RectI {
    if rect.right <= rect.left {
        match rect.left.checked_add(1) {
            Some(right) => rect.right = right,
            None => rect.left = rect.right.saturating_sub(1),
        }
    }
    if rect.bottom <= rect.top {
        match rect.top.checked_add(1) {
            Some(bottom) => rect.bottom = bottom,
            None => rect.top = rect.bottom.saturating_sub(1),
        }
    }
    rect
}

/// Force `rect` to `aspect` (`width / height`) while honouring which edge or
/// corner the user is dragging (`edge`, i.e. `WM_SIZING`'s `wParam`).
///
/// Anchoring rules — the edge/corner the user did NOT grab stays where it
/// was:
///
/// * `WMSZ_LEFT` / `WMSZ_RIGHT` (horizontal edge dragged): the width is what
///   the user just chose, so `height = round(width / aspect)` and the TOP
///   edge is fixed. `LEFT` keeps `right`, `RIGHT` keeps `left`.
/// * `WMSZ_TOP` / `WMSZ_BOTTOM` (vertical edge dragged): the height is what
///   the user just chose, so `width = round(height * aspect)` and the LEFT
///   edge is fixed. `TOP` keeps `bottom`, `BOTTOM` keeps `top`.
/// * Corners: the dragged corner is the grabbed one, so the width the drag
///   produced is authoritative and `height = round(width / aspect)`; the
///   OPPOSITE corner stays fixed.
///
/// A non-finite or non-positive `aspect` (unknown yet at startup) and an
/// unknown `edge` return `rect` untouched — the caller must not claim the
/// message in that case.
pub(crate) fn constrain_rect(rect: RectI, edge: u32, aspect: f64) -> RectI {
    if !aspect.is_finite() || aspect <= 0.0 {
        return rect;
    }
    let (raw_width, raw_height) = rect.size();
    let mut width = raw_width.max(1);
    let mut height = raw_height.max(1);
    match edge {
        // Horizontal edges: the dragged axis is the width, derive the height.
        WMSZ_LEFT | WMSZ_RIGHT => {
            height = dimension(width as f64 / aspect);
        }
        // Vertical edges: the dragged axis is the height, derive the width.
        WMSZ_TOP | WMSZ_BOTTOM => {
            width = dimension(height as f64 * aspect);
        }
        // Corners: derive the height from the dragged width.
        WMSZ_TOPLEFT | WMSZ_TOPRIGHT | WMSZ_BOTTOMLEFT | WMSZ_BOTTOMRIGHT => {
            height = dimension(width as f64 / aspect);
        }
        _ => return rect,
    }
    width = width.clamp(1, i32::MAX as i64);
    height = height.clamp(1, i32::MAX as i64);
    let out = match edge {
        WMSZ_LEFT => RectI {
            left: coordinate(rect.right as i64 - width),
            top: rect.top,
            right: rect.right,
            bottom: coordinate(rect.top as i64 + height),
        },
        WMSZ_RIGHT => RectI {
            left: rect.left,
            top: rect.top,
            right: coordinate(rect.left as i64 + width),
            bottom: coordinate(rect.top as i64 + height),
        },
        WMSZ_TOP => RectI {
            left: rect.left,
            top: coordinate(rect.bottom as i64 - height),
            right: coordinate(rect.left as i64 + width),
            bottom: rect.bottom,
        },
        WMSZ_BOTTOM => RectI {
            left: rect.left,
            top: rect.top,
            right: coordinate(rect.left as i64 + width),
            bottom: coordinate(rect.top as i64 + height),
        },
        WMSZ_TOPLEFT => RectI {
            left: coordinate(rect.right as i64 - width),
            top: coordinate(rect.bottom as i64 - height),
            right: rect.right,
            bottom: rect.bottom,
        },
        WMSZ_TOPRIGHT => RectI {
            left: rect.left,
            top: coordinate(rect.bottom as i64 - height),
            right: coordinate(rect.left as i64 + width),
            bottom: rect.bottom,
        },
        WMSZ_BOTTOMLEFT => RectI {
            left: coordinate(rect.right as i64 - width),
            top: rect.top,
            right: rect.right,
            bottom: coordinate(rect.top as i64 + height),
        },
        WMSZ_BOTTOMRIGHT => RectI {
            left: rect.left,
            top: rect.top,
            right: coordinate(rect.left as i64 + width),
            bottom: coordinate(rect.top as i64 + height),
        },
        _ => return rect,
    };
    normalise(out)
}

#[cfg(test)]
mod tests {
    use super::{
        constrain_rect, RectI, WMSZ_BOTTOM, WMSZ_BOTTOMLEFT, WMSZ_BOTTOMRIGHT, WMSZ_LEFT,
        WMSZ_RIGHT, WMSZ_TOP, WMSZ_TOPLEFT, WMSZ_TOPRIGHT,
    };
    /// 16:9, the ratio every rectangle case below uses.
    const SIXTEEN_BY_NINE: f64 = 16.0 / 9.0;

    fn rect(left: i32, top: i32, right: i32, bottom: i32) -> RectI {
        RectI {
            left,
            top,
            right,
            bottom,
        }
    }

    fn size(candidate: RectI) -> (i32, i32) {
        (
            candidate.right - candidate.left,
            candidate.bottom - candidate.top,
        )
    }

    /// Dragging the RIGHT edge keeps the drag's width and derives the height;
    /// the top edge must not move. 480 / (16/9) = 270.
    #[test]
    fn wmsz_right_derives_height_from_kept_width() {
        let out = constrain_rect(rect(0, 0, 480, 300), WMSZ_RIGHT, SIXTEEN_BY_NINE);
        assert_eq!(out, rect(0, 0, 480, 270));
        assert_eq!(size(out), (480, 270));
    }

    /// Dragging the BOTTOM edge keeps the drag's height and derives the width;
    /// the left edge must not move. 300 * (16/9) = 533.
    #[test]
    fn wmsz_bottom_derives_width_from_dragged_height() {
        let out = constrain_rect(rect(0, 0, 480, 300), WMSZ_BOTTOM, SIXTEEN_BY_NINE);
        assert_eq!(size(out), (533, 300));
        assert_eq!((out.left, out.top), (0, 0));
    }

    /// Dragging the LEFT edge moves `left` (it follows the drag), keeps `right`
    /// and `top`, and recomputes the height from the new width. 450 * 9/16 =
    /// 253.125 -> 253.
    #[test]
    fn wmsz_left_keeps_right_edge() {
        let out = constrain_rect(rect(130, 50, 580, 350), WMSZ_LEFT, SIXTEEN_BY_NINE);
        assert_eq!(out, rect(130, 50, 580, 303));
    }

    /// Dragging the TOP edge moves `top`, keeps `bottom` and `left`, and
    /// recomputes the width from the dragged height. 330 * 16/9 = 586.67 -> 587.
    #[test]
    fn wmsz_top_keeps_bottom_edge() {
        let out = constrain_rect(rect(100, 20, 580, 350), WMSZ_TOP, SIXTEEN_BY_NINE);
        assert_eq!(out, rect(100, 20, 687, 350));
    }

    /// Dragging the top-left corner: `left` follows the drag because the width
    /// comes from the dragged rect, `top` is derived, and the OPPOSITE corner
    /// (bottom-right) stays exactly where it was. 450 * 9/16 = 253.
    #[test]
    fn wmsz_topleft_keeps_opposite_corner() {
        let out = constrain_rect(rect(130, 20, 580, 350), WMSZ_TOPLEFT, SIXTEEN_BY_NINE);
        assert_eq!(out, rect(130, 97, 580, 350));
    }

    /// Dragging the top-right corner: `right` follows the drag, `top` is derived,
    /// and the bottom-left corner stays fixed. 540 * 9/16 = 303.75 -> 304.
    #[test]
    fn wmsz_topright_keeps_opposite_corner() {
        let out = constrain_rect(rect(100, 20, 640, 350), WMSZ_TOPRIGHT, SIXTEEN_BY_NINE);
        assert_eq!(out, rect(100, 46, 640, 350));
    }

    /// Dragging the bottom-left corner: `left` follows the drag, `bottom` is
    /// derived, and the top-right corner stays fixed.
    #[test]
    fn wmsz_bottomleft_keeps_opposite_corner() {
        let out = constrain_rect(rect(130, 50, 580, 380), WMSZ_BOTTOMLEFT, SIXTEEN_BY_NINE);
        assert_eq!(out, rect(130, 50, 580, 303));
    }

    /// Dragging the bottom-right corner: `right` follows the drag, `bottom` is
    /// derived, and the top-left corner stays fixed. 540 * 9/16 = 303.75 -> 304,
    /// so `bottom = 50 + 304`.
    #[test]
    fn wmsz_bottomright_keeps_opposite_corner() {
        let out = constrain_rect(rect(100, 50, 640, 380), WMSZ_BOTTOMRIGHT, SIXTEEN_BY_NINE);
        assert_eq!(out, rect(100, 50, 640, 354));
    }

    /// A fast drag can hand us a zero-sized or inverted rect. Every dimension
    /// must still be at least one pixel — never zero, never inverted, never NaN
    /// (the aspect is a float, so a 0-height input would otherwise divide to a
    /// non-finite height).
    #[test]
    fn degenerate_drags_never_go_below_one_pixel() {
        let cases = [
            (rect(0, 0, 480, 0), WMSZ_BOTTOM),
            (rect(0, 100, 480, 40), WMSZ_BOTTOM),
            (rect(10, 0, 0, 300), WMSZ_LEFT),
            (rect(0, 0, 0, 0), WMSZ_BOTTOMRIGHT),
        ];
        for (input, edge) in cases {
            let out = constrain_rect(input, edge, SIXTEEN_BY_NINE);
            let (width, height) = size(out);
            assert!(width >= 1, "width {width} for {input:?} / {edge}");
            assert!(height >= 1, "height {height} for {input:?} / {edge}");
            assert!(out.right > out.left, "inverted horizontally: {out:?}");
            assert!(out.bottom > out.top, "inverted vertically: {out:?}");
        }
    }

    /// An anchor pinned to the very edge of the i32 coordinate space cannot have
    /// its far edge moved (it would clamp back onto the anchor). The rect must
    /// still enclose at least one pixel instead of collapsing — this is the
    /// `normalise` fallback, unreachable on any real screen but the reason
    /// "never a zero/negative rect" is unconditional.
    #[test]
    fn extreme_coordinates_still_enclose_one_pixel() {
        // `WMSZ_RIGHT` at `left == i32::MAX`: `left + width` clamps back onto the
        // anchor, so the far edge cannot be moved and the ANCHOR has to give way.
        let out = constrain_rect(
            rect(i32::MAX, 0, i32::MAX, 300),
            WMSZ_RIGHT,
            SIXTEEN_BY_NINE,
        );
        assert!(out.right > out.left, "inverted horizontally: {out:?}");
        assert!(out.bottom > out.top, "inverted vertically: {out:?}");
        let (width, height) = size(out);
        assert!(width >= 1, "width {width} for {out:?}");
        assert!(height >= 1, "height {height} for {out:?}");
    }

    /// No aspect known yet (startup), or a nonsense one: the rect must come back
    /// byte-for-byte unchanged so the caller can forward the message.
    #[test]
    fn invalid_aspect_leaves_rect_untouched() {
        let input = rect(100, 50, 580, 350);
        for aspect in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 0.0, -1.6] {
            for edge in [
                WMSZ_LEFT,
                WMSZ_RIGHT,
                WMSZ_TOP,
                WMSZ_BOTTOM,
                WMSZ_TOPLEFT,
                WMSZ_TOPRIGHT,
                WMSZ_BOTTOMLEFT,
                WMSZ_BOTTOMRIGHT,
            ] {
                assert_eq!(
                    constrain_rect(input, edge, aspect),
                    input,
                    "aspect {aspect} / edge {edge} must not touch the rect"
                );
            }
        }
    }

    /// The mirrored constants are only as good as their values: pin them to the
    /// real Win32 ones so a typo cannot silently map an edge to the wrong axis.
    #[cfg(windows)]
    #[test]
    fn local_edges_match_win32() {
        use windows_sys::Win32::UI::WindowsAndMessaging as wam;
        assert_eq!(WMSZ_LEFT, wam::WMSZ_LEFT);
        assert_eq!(WMSZ_RIGHT, wam::WMSZ_RIGHT);
        assert_eq!(WMSZ_TOP, wam::WMSZ_TOP);
        assert_eq!(WMSZ_TOPLEFT, wam::WMSZ_TOPLEFT);
        assert_eq!(WMSZ_TOPRIGHT, wam::WMSZ_TOPRIGHT);
        assert_eq!(WMSZ_BOTTOM, wam::WMSZ_BOTTOM);
        assert_eq!(WMSZ_BOTTOMLEFT, wam::WMSZ_BOTTOMLEFT);
        assert_eq!(WMSZ_BOTTOMRIGHT, wam::WMSZ_BOTTOMRIGHT);
    }
}
