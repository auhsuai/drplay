/** S4: custom properties carrying the host rect (CSS px, relative to <main>)
 *  that the player background layer clips its transparent hole with. Left
 *  unset they resolve to the layer's 0/0 corner => zero-size hole => opaque,
 *  which is the safe placeholder state before the first measurement. */
const HOLE_VARS = [
  "--drplay-hole-l",
  "--drplay-hole-t",
  "--drplay-hole-r",
  "--drplay-hole-b",
] as const;

/** S4: publish the host rect for the background layer's clip hole. The
 *  consumer is an absolutely-positioned child of <main>, so the coordinates
 *  are made relative to that box — the overlay slide translates the whole
 *  subtree, and a viewport-relative rect would drift by the slide offset
 *  while a main-relative one stays exact. */
export function publishHoleRect(box: HTMLElement, rect: DOMRect): void {
  const main = box.closest("main");
  if (!main) return;
  const origin = main.getBoundingClientRect();
  const left = Math.max(0, rect.left - origin.left);
  const top = Math.max(0, rect.top - origin.top);
  const style = document.documentElement.style;
  style.setProperty(HOLE_VARS[0], `${String(left)}px`);
  style.setProperty(HOLE_VARS[1], `${String(top)}px`);
  style.setProperty(HOLE_VARS[2], `${String(left + rect.width)}px`);
  style.setProperty(HOLE_VARS[3], `${String(top + rect.height)}px`);
}

export function clearHoleRect(): void {
  const style = document.documentElement.style;
  for (const name of HOLE_VARS) style.removeProperty(name);
}
