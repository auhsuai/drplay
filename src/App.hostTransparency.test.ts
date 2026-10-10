// @vitest-environment node
/**
 * S4b regression guard for the "video invisible in the real app" bug.
 *
 * The bug was invisible to the whole test suite because it lived in a CSS
 * rule: the DComp video visual composites BELOW the WebView2 child window, so
 * ANY opaque page paint over the rect hides the video — and the shell behind
 * the Now Playing overlay was still painting its own background through the
 * background layer's clip hole. Observed symptom: the video rect showed the tab
 * root's own #0A0A0A while the engine logs (interop registered, render context
 * created, surface recreated) were all healthy.
 *
 * This test reads App.css as text on purpose. A jsdom render cannot express
 * "the page is alpha=0 over this rect": jsdom has no compositing, no
 * WebView2 and no DComp, and `getComputedStyle` would happily report
 * `transparent` for a rule that never shipped. The rule's own presence is the
 * contract, so assert on the source.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Comments are stripped first: a CSS comment has no braces, so without this
// the comment text would be swallowed into the "selector" chunk and every
// assertion would depend on how the prose happens to be punctuated.
const css = readFileSync(
  fileURLToPath(new URL("./App.css", import.meta.url)),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * The declaration block of the rule whose selector list contains exactly
 * `selector`. Selector lists are split on commas and trimmed, so a selector
 * containing `*` or `#` is compared literally rather than through a regex
 * word-boundary (which can never match next to `*`).
 */
function ruleBodyFor(selector: string): string {
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (match[1] ?? "").split(",").map((part) => part.trim());
    if (selectors.includes(selector)) return match[2] ?? "";
  }
  throw new Error(`App.css must contain a rule for \`${selector}\``);
}

describe("S4b: the shell must not paint over the video rect", () => {
  it("drops background-color on the two structural roots of the shell subtree", () => {
    // `#content-area` holds every tab root, MainContent, LikedSongs and the
    // QueuePanel; `aside` is the sidebar. The Now Playing overlay is a SIBLING
    // of AppShell, so scoping to these two roots can never touch the overlay's
    // own background layer (the one that punches the hole).
    for (const selector of [
      "html.drplay-host-visible aside",
      "html.drplay-host-visible aside *",
      "html.drplay-host-visible #content-area",
      "html.drplay-host-visible #content-area *",
    ]) {
      expect(ruleBodyFor(selector)).toContain("background-color: transparent");
    }
  });

  it("clears background-image too — the same full-bleed layers set gradients via `background`", () => {
    // SettingsTab and LikedSongs paint a `bg-gradient-to-*` header straight
    // through the hole; `background-color: transparent` alone leaves them.
    const body = ruleBodyFor("html.drplay-host-visible #content-area *");
    expect(body).toContain("background-image: none");
  });

  it("S4c: stops the whole shell from PAINTING at all — inline backgrounds and glyphs survive the background reset", () => {
    // HomeTab cards set their color through an inline `style="background:
    // <palette>"` (inline beats stylesheets) and text/icons are foreground
    // paint; both leaked through the hole as the Home ghost. The paint switch
    // (inherited) is the only rule that reaches inline styles.
    for (const selector of [
      "html.drplay-host-visible aside",
      "html.drplay-host-visible aside *",
      "html.drplay-host-visible #content-area",
      "html.drplay-host-visible #content-area *",
    ]) {
      expect(ruleBodyFor(selector)).toContain("visibility: hidden");
    }
    // `transition: all` nodes stay visible for the whole transition when
    // visibility flips; the reset makes the hide instant.
    expect(ruleBodyFor("html.drplay-host-visible #content-area *")).toContain(
      "transition-property: none",
    );
  });

  it("keeps the pre-existing S4 rule that html/body/app-root/overlay already honoured", () => {
    const body = ruleBodyFor("html.drplay-host-visible .drplay-host-clear");
    expect(body).toContain("background-color: transparent");
  });
});
