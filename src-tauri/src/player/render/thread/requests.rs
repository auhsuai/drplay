use super::super::shared::Request;

/// Whether a frontend rect request requires rebuilding the whole present
/// pipeline (GL FBO storage -> interop texture -> registration -> DComp
/// surface). Pure so the resize/sync contract is unit-tested without a GL or
/// D3D context — the present-time `CopySubresourceRegion` pairs the interop
/// texture with the surface texture, so the two must never drift apart in size.
///
/// A COLLAPSED rect (zero/negative, minimized window or a pre-layout read)
/// never rebuilds: there is no target size to build, and `Composition::set_rect`
/// leaves the surface alone for exactly that case.
pub(crate) fn needs_size_sync(current: (u32, u32), requested: (u32, u32)) -> bool {
    requested.0 > 0 && requested.1 > 0 && current != requested
}

/// Coalesce a drained request batch so a resize drag does not rebuild the
/// whole present pipeline for every intermediate pixel.
///
/// The batch is applied completely before the pump, so intermediate geometry is
/// never presented: only the LAST `SetRect` / `SetVisible` of a segment can
/// affect the frame. EVERY other request is a barrier that cuts a segment and is
/// always kept, because each one observes the pipeline immediately:
///  * `Retarget` replaces the whole present pipeline — a rect before it belongs
///    to the OLD one, a rect after it to the NEW one, so neither may be dropped.
///  * `Resize` reallocates the GL FBO and `Sample` reads it back, so a rect
///    queued before them must already be applied when they run.
///
/// Within a segment only the last rect / visibility survives, which is exactly
/// the drag case (dozens of 1px rects, one effective rebuild).
pub(crate) fn coalesce_requests(requests: Vec<Request>) -> Vec<Request> {
    let mut keep = vec![true; requests.len()];
    let mut later_rect = false;
    let mut later_visible = false;
    for (index, request) in requests.iter().enumerate().rev() {
        match request {
            Request::Retarget { .. }
            | Request::Resize { .. }
            | Request::Sample { .. } => {
                later_rect = false;
                later_visible = false;
            }
            Request::SetRect { .. } => {
                if later_rect {
                    keep[index] = false;
                } else {
                    later_rect = true;
                }
            }
            Request::SetVisible { .. } => {
                if later_visible {
                    keep[index] = false;
                } else {
                    later_visible = true;
                }
            }
        }
    }
    requests
        .into_iter()
        .zip(keep)
        .filter_map(|(request, keep_it)| if keep_it { Some(request) } else { None })
        .collect()
}
