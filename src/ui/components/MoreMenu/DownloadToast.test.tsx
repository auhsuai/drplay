// @vitest-environment jsdom
// DownloadToast kind + stacking: every error (incl. no_space) must show
// the red "!" — never the green check — and simultaneous toasts must
// stack with one uniform gap instead of landing on top of each other.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { DownloadToast, DOWNLOAD_TOAST_STACK_ID } from "./DownloadToast";

beforeEach(() => {
  document.body.innerHTML = '<div id="content-area"></div>';
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("DownloadToast icon by kind", () => {
  // The toast portals into #download-toast-stack (outside RTL's
  // container), so icon queries go through `document`, not `container`.
  it("error shows the red CircleAlert (!), not the green Check", () => {
    render(<DownloadToast message="Not enough free space" kind="error" />);

    expect(document.querySelector("svg.lucide-circle-alert")).not.toBeNull();
    expect(document.querySelector("svg.lucide-check")).toBeNull();
    const icon = document.querySelector("svg.lucide-circle-alert");
    expect(icon?.getAttribute("class")).toContain("text-red-600");
  });

  it("error toasts use role=alert and assertive announcements", () => {
    render(<DownloadToast message="boom" kind="error" />);

    const toast = document.querySelector('[role="alert"]');
    expect(toast).not.toBeNull();
    expect(toast?.getAttribute("aria-live")).toBe("assertive");
    expect(toast?.textContent).toContain("boom");
  });

  it("success shows the green Check and role=status", () => {
    render(<DownloadToast message="Saved to /Downloads/x" kind="success" />);

    expect(document.querySelector("svg.lucide-check")).not.toBeNull();
    expect(document.querySelector("svg.lucide-circle-alert")).toBeNull();
    const icon = document.querySelector("svg.lucide-check");
    expect(icon?.getAttribute("class")).toContain("text-green-600");
    expect(document.querySelector('[role="status"]')).not.toBeNull();
  });

  it("info (progress/cancelled) shows the neutral Info icon", () => {
    render(<DownloadToast message="Downloading 1 of 3 files…" kind="info" />);

    expect(document.querySelector("svg.lucide-info")).not.toBeNull();
    expect(document.querySelector("svg.lucide-check")).toBeNull();
    expect(document.querySelector("svg.lucide-circle-alert")).toBeNull();
  });

  it("defaults to success for callers that predate kinds (debug trigger)", () => {
    render(<DownloadToast message="ok" />);

    expect(document.querySelector("svg.lucide-check")).not.toBeNull();
  });
});

describe("DownloadToast stack spacing", () => {
  it("two simultaneous toasts share ONE stack with a uniform 12px gap", () => {
    render(
      <>
        <DownloadToast message="first" kind="success" />
        <DownloadToast message="second" kind="error" />
      </>,
    );

    const stacks = document.querySelectorAll(`#${DOWNLOAD_TOAST_STACK_ID}`);
    expect(stacks).toHaveLength(1);
    const stack = document.getElementById(DOWNLOAD_TOAST_STACK_ID);
    expect(stack).not.toBeNull();
    expect(stack?.childElementCount).toBe(2);
    // One gap token (gap-3 = 12px) between toasts, 16px from the
    // content-area's left edge, 80px from the bottom (PlayerBar clearance,
    // same offsets as simpleToast's right:16px / bottom:80px).
    expect(stack?.className).toContain("gap-3");
    expect(stack?.className).toContain("left-4");
    expect(stack?.className).toContain("bottom-20");
    expect(stack?.textContent).toContain("first");
    expect(stack?.textContent).toContain("second");
  });

  it("the stack lives inside #content-area, not on document.body", () => {
    render(<DownloadToast message="ok" />);

    const stack = document.getElementById(DOWNLOAD_TOAST_STACK_ID);
    expect(stack?.parentElement?.id).toBe("content-area");
  });

  it("a single toast uses the same stack position as a stacked one", () => {
    render(<DownloadToast message="only" kind="info" />);

    const stack = document.getElementById(DOWNLOAD_TOAST_STACK_ID);
    expect(stack).not.toBeNull();
    expect(stack?.childElementCount).toBe(1);
    expect(stack?.className).toContain("gap-3");
  });

  it("unmounting the last toast removes the empty stack", () => {
    const { unmount } = render(<DownloadToast message="ok" />);
    expect(document.getElementById(DOWNLOAD_TOAST_STACK_ID)).not.toBeNull();

    unmount();

    expect(document.getElementById(DOWNLOAD_TOAST_STACK_ID)).toBeNull();
  });
});
