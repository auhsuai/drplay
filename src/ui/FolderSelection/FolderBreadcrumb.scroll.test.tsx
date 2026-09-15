// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { FolderBreadcrumb } from "./FolderBreadcrumb";

// Long history so the breadcrumb would overflow horizontally in a real layout
// (jsdom has no layout, but the scrollLeft math is still exercised). Mirrors
// TopNavigationBar.scroll.test.tsx — the shared hook must keep both donors
// behaviorally identical.
const LONG_HISTORY = Array.from({ length: 25 }, (_, i) => ({
  id: `f${String(i)}`,
  name: `Folder ${String(i)}`,
}));

function renderBreadcrumb(
  overrides: Partial<{
    folderHistory: { id: string; name: string }[];
    currentFolderName: string;
    onBreadcrumbClick: (index: number) => void;
  }> = {},
) {
  return render(
    <FolderBreadcrumb
      folderHistory={LONG_HISTORY}
      currentFolderName="current"
      onBreadcrumbClick={vi.fn()}
      {...overrides}
    />,
  );
}

const getScroller = () =>
  document.querySelector(".hide-scrollbar") as HTMLDivElement;

describe("FolderBreadcrumb horizontal scroll (wheel + drag, P2-10-2)", () => {
  afterEach(() => {
    cleanup();
  });

  it("chuột wheel (deltaY) cuộn ngang breadcrumb + preventDefault", () => {
    renderBreadcrumb();
    const el = getScroller();
    const evt = new WheelEvent("wheel", {
      deltaY: 120,
      deltaX: 0,
      cancelable: true,
      bubbles: true,
    });
    el.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
    expect(el.scrollLeft).toBe(120);
  });

  it("trackpad wheel (deltaX) vẫn cuộn ngang", () => {
    renderBreadcrumb();
    const el = getScroller();
    el.dispatchEvent(
      new WheelEvent("wheel", { deltaX: 40, deltaY: 0, cancelable: true }),
    );
    expect(el.scrollLeft).toBe(40);
  });

  it("deltaX + deltaY cộng dồn (chuyển chéo trackpad)", () => {
    renderBreadcrumb();
    const el = getScroller();
    el.dispatchEvent(
      new WheelEvent("wheel", { deltaX: 30, deltaY: 70, cancelable: true }),
    );
    expect(el.scrollLeft).toBe(100);
  });

  it("click thuần (pointerdown không di chuyển) KHÔNG gọi setPointerCapture", () => {
    renderBreadcrumb();
    const el = getScroller();
    const captureSpy = vi.fn();
    el.setPointerCapture = captureSpy;
    fireEvent.pointerDown(el, { clientX: 100, pointerId: 7 });
    expect(captureSpy).not.toHaveBeenCalled();
    expect(el.scrollLeft).toBe(0);
  });

  it("di chuyển dưới ngưỡng drag (5px) không bắt đầu drag", () => {
    renderBreadcrumb();
    const el = getScroller();
    const captureSpy = vi.fn();
    el.setPointerCapture = captureSpy;
    fireEvent.pointerDown(el, { clientX: 100, pointerId: 8 });
    fireEvent.pointerMove(el, { clientX: 97, pointerId: 8 });
    expect(captureSpy).not.toHaveBeenCalled();
    expect(el.scrollLeft).toBe(0);
  });

  it("drag chuột cuộn ngang theo clientX, kết thúc khi pointerup", () => {
    renderBreadcrumb();
    const el = getScroller();
    const captureSpy = vi.fn();
    el.setPointerCapture = captureSpy;
    fireEvent.pointerDown(el, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(el, { clientX: 50, pointerId: 1 });
    expect(captureSpy).toHaveBeenCalled();
    expect(el.scrollLeft).toBe(50);
    fireEvent.pointerMove(el, { clientX: 0, pointerId: 1 });
    expect(el.scrollLeft).toBe(100);
    fireEvent.pointerUp(el, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(el, { clientX: 200, pointerId: 1 });
    expect(el.scrollLeft).toBe(100);
  });
});

describe("FolderBreadcrumb crumbs are native buttons (P2-10-7)", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders a real <button type=button> and reports the crumb index on click", () => {
    const onBreadcrumbClick = vi.fn();
    renderBreadcrumb({
      folderHistory: [
        { id: "f0", name: "Folder A" },
        { id: "f1", name: "Folder B" },
      ],
      onBreadcrumbClick,
    });

    const crumb = screen.getByRole("button", { name: "Folder A" });
    expect(crumb.tagName).toBe("BUTTON");
    expect(crumb.getAttribute("type")).toBe("button");

    fireEvent.click(crumb);
    expect(onBreadcrumbClick).toHaveBeenCalledWith(0);

    fireEvent.click(screen.getByRole("button", { name: "Folder B" }));
    expect(onBreadcrumbClick).toHaveBeenCalledWith(1);
  });

  it("click breadcrumb vẫn hoạt động sau pointerdown/up không di chuyển", () => {
    const onBreadcrumbClick = vi.fn();
    renderBreadcrumb({
      folderHistory: [{ id: "f1", name: "Folder A" }],
      onBreadcrumbClick,
    });
    const el = getScroller();
    fireEvent.pointerDown(el, { clientX: 100, pointerId: 2 });
    fireEvent.pointerUp(el, { clientX: 100, pointerId: 2 });
    expect(el.scrollLeft).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Folder A" }));
    expect(onBreadcrumbClick).toHaveBeenCalledWith(0);
  });
});
