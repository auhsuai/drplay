// Background classes already exist in the Tailwind build (used by the buffer
// bar in PlayerBar/NowPlaying), so referencing them here keeps dynamic
// segments styled without extra CSS. Positioning is done via inline styles to
// stay robust regardless of Tailwind purging.
const BUFFER_SEGMENT_BG = 'bg-gray-400 dark:bg-gray-500';

/**
 * Render the buffer bar from the app's CUSTOM streaming proxy byte accounting.
 *
 * This app streams audio through a Rust proxy (src-tauri/src/proxy.rs) that
 * slices files into chunks and emits a `buffer-status` Tauri event carrying
 * buffer_start_byte / buffer_end_byte / total_size_byte. The browser's native
 * `HTMLMediaElement.buffered` is NOT populated by this proxy (confirmed: it
 * always reports zero ranges for a stream served this way), so it CANNOT
 * drive the buffer bar. The proxy's byte range IS the authoritative buffer
 * source here — this is the standard fallback recommended for custom/chunked
 * streaming pipelines where the native buffered API isn't populated (see
 * Shaka Player's own `buffering_observer`, which drives its indicator from
 * the streaming engine's byte/segment accounting rather than the media
 * element when a custom pipeline is in play).
 *
 * Fills `container` with a single segment from startByte..endByte.
 */
export function renderBufferFromBytes(
  container: HTMLElement | null,
  startByte: number,
  endByte: number,
  totalByte: number,
): void {
  if (!container) return;

  if (!totalByte || totalByte <= 0 || endByte <= 0 || endByte < startByte) {
    if (container.childElementCount > 0) container.innerHTML = '';
    return;
  }

  const startPct = (startByte / totalByte) * 100;
  const widthPct = ((endByte - startByte) / totalByte) * 100;

  if (container.childElementCount !== 1) {
    container.innerHTML = '';
    const seg = document.createElement('div');
    seg.className = BUFFER_SEGMENT_BG;
    seg.style.position = 'absolute';
    seg.style.top = '0';
    seg.style.height = '100%';
    seg.style.pointerEvents = 'none';
    container.appendChild(seg);
  }
  const seg = container.children[0] as HTMLElement;
  seg.style.left = `${startPct}%`;
  seg.style.width = `${widthPct}%`;
}
