// @vitest-environment jsdom
// Floating download bubble: exact lucide Download icon, round bordered
// bubble, click opens the panel, a drag moves it (clamped to the content
// area) and persists the spot.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, screen } from "@testing-library/react";
import { DownloadFab } from "./DownloadFab";
import {
  DOWNLOAD_FAB_STORAGE_KEY,
  DOWNLOAD_FAB_SIZE_PX,
} from "../../../utils/downloadFabPosition";

function mockContainerRect(button: HTMLElement, width = 800, height = 600) {
  const container = button.parentElement;
  if (!container) throw new Error("FAB has no parent container");
  Object.defineProperty(button, "offsetParent", {
    value: container,
    configurable: true,
  });
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
    width,
    height,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  return container;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("DownloadFab", () => {
  it("is hidden when there is no job running", () => {
    render(
      <div>
        <DownloadFab visible={false} onClick={() => {}} label="Downloads" />
      </div>,
    );

    expect(screen.queryByLabelText("Downloads")).toBeNull();
  });

  it("renders the exact lucide Download icon (24×24, stroke 2) in a round bordered bubble", () => {
    render(
      <div>
        <DownloadFab visible onClick={() => {}} label="Downloads" />
      </div>,
    );

    const button = screen.getByLabelText("Downloads");
    expect(button.className).toContain("rounded-full");
    expect(button.className).toContain("border");
    const svg = button.querySelector("svg.lucide-download");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("class")).toContain("w-6");
    expect(svg?.getAttribute("class")).toContain("h-6");
    // The icon's own paths, as specified (this lucide version renders
    // them as <path> elements: stem, tray, and the m7 10 5 5 5-5 chevron).
    expect(
      button.querySelector(
        'path[d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"]',
      ),
    ).not.toBeNull();
    expect(button.querySelector('path[d="m7 10 5 5 5-5"]')).not.toBeNull();
    expect(button.querySelector('path[d="M12 15V3"]')).not.toBeNull();
  });

  it("shows the job badge while downloading", () => {
    render(
      <div>
        <DownloadFab
          visible
          onClick={() => {}}
          label="Downloads"
          badge="3/14"
        />
      </div>,
    );

    expect(screen.getByText("3/14")).toBeInTheDocument();
  });

  it("a click (no drag) opens the panel", () => {
    const onClick = vi.fn();
    render(
      <div style={{ position: "relative" }}>
        <DownloadFab visible onClick={onClick} label="Downloads" />
      </div>,
    );
    const button = screen.getByLabelText("Downloads");
    mockContainerRect(button);

    fireEvent.pointerDown(button, {
      pointerId: 1,
      clientX: 700,
      clientY: 500,
    });
    fireEvent.pointerUp(button, { pointerId: 1, clientX: 700, clientY: 500 });

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(DOWNLOAD_FAB_STORAGE_KEY)).toBeNull();
  });

  it("a drag moves the button, clamps it inside the content area, and persists the spot", () => {
    const onClick = vi.fn();
    render(
      <div style={{ position: "relative" }}>
        <DownloadFab visible onClick={onClick} label="Downloads" />
      </div>,
    );
    const button = screen.getByLabelText("Downloads");
    mockContainerRect(button, 800, 600);

    // Default corner is (728, 528); drag 600px left and 400px up.
    fireEvent.pointerDown(button, {
      pointerId: 1,
      clientX: 700,
      clientY: 500,
    });
    fireEvent.pointerMove(button, {
      pointerId: 1,
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerUp(button, { pointerId: 1, clientX: 100, clientY: 100 });

    expect(onClick).not.toHaveBeenCalled();
    expect(button.style.left).toBe("128px");
    expect(button.style.top).toBe("128px");
    expect(
      JSON.parse(localStorage.getItem(DOWNLOAD_FAB_STORAGE_KEY) ?? ""),
    ).toEqual({ x: 128, y: 128 });
  });

  it("a drag past the edge stops at the 16px inner margin, never outside", () => {
    render(
      <div style={{ position: "relative" }}>
        <DownloadFab visible onClick={() => {}} label="Downloads" />
      </div>,
    );
    const button = screen.getByLabelText("Downloads");
    mockContainerRect(button, 800, 600);

    fireEvent.pointerDown(button, {
      pointerId: 1,
      clientX: 700,
      clientY: 500,
    });
    fireEvent.pointerMove(button, {
      pointerId: 1,
      clientX: -500,
      clientY: -500,
    });
    fireEvent.pointerUp(button, {
      pointerId: 1,
      clientX: -500,
      clientY: -500,
    });

    expect(button.style.left).toBe("16px");
    expect(button.style.top).toBe("16px");
  });

  it("restores a persisted position on mount", () => {
    localStorage.setItem(
      DOWNLOAD_FAB_STORAGE_KEY,
      JSON.stringify({ x: 200, y: 150 }),
    );
    render(
      <div>
        <DownloadFab visible onClick={() => {}} label="Downloads" />
      </div>,
    );

    const button = screen.getByLabelText("Downloads");
    expect(button.style.left).toBe("200px");
    expect(button.style.top).toBe("150px");
    expect(DOWNLOAD_FAB_SIZE_PX).toBe(56);
  });
});
