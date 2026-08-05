// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type React from "react";
import { TopNavigationBar } from "./TopNavigationBar";

// react-i18next has no initialized instance in the node test env (i18n.ts
// touches localStorage at import time), so we stub useTranslation to return
// the defaultValue passed to t().
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, defaultValue?: string) => defaultValue ?? _key,
  }),
}));

interface TopNavProps {
  isSelectionMode: boolean;
  selectedCount: number;
  onClearSelection: () => void;
  onBack: () => void;
  hasHistory: boolean;
  folderHistory: { id: string; name: string }[];
  currentFolderName: string;
  onBreadcrumbClick: (id: string, name: string, index: number) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  sortOption: string;
  onSortChange: (option: string) => void;
  token: string | null;
  onNewFolderClick: () => void;
  isInitialMount: React.RefObject<boolean>;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
}

function makeProps(overrides: Partial<TopNavProps> = {}): TopNavProps {
  return {
    isSelectionMode: false,
    selectedCount: 0,
    onClearSelection: vi.fn(),
    onBack: vi.fn(),
    hasHistory: false,
    folderHistory: [],
    currentFolderName: "root",
    onBreadcrumbClick: vi.fn(),
    searchQuery: "",
    onSearchChange: vi.fn(),
    sortOption: "name",
    onSortChange: vi.fn(),
    token: "token",
    onNewFolderClick: vi.fn(),
    isInitialMount: { current: true },
    searchInputRef: { current: null },
    ...overrides,
  };
}

// Long history so the breadcrumb would overflow horizontally in a real layout
// (jsdom has no layout, but the scrollLeft math is still exercised).
const LONG_HISTORY = Array.from({ length: 25 }, (_, i) => ({
  id: `f${String(i)}`,
  name: `Folder ${String(i)}`,
}));

const getBreadcrumb = () =>
  document.querySelector(".hide-scrollbar") as HTMLDivElement;

describe("TopNavigationBar breadcrumb horizontal scroll (wheel + drag)", () => {
  afterEach(() => {
    cleanup();
  });

  it("chuột wheel (deltaY) cuộn ngang breadcrumb + preventDefault", () => {
    render(
      <TopNavigationBar
        {...makeProps({
          folderHistory: LONG_HISTORY,
          currentFolderName: "current",
        })}
      />,
    );
    const el = getBreadcrumb();
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
    render(
      <TopNavigationBar
        {...makeProps({
          folderHistory: LONG_HISTORY,
          currentFolderName: "current",
        })}
      />,
    );
    const el = getBreadcrumb();
    el.dispatchEvent(
      new WheelEvent("wheel", { deltaX: 40, deltaY: 0, cancelable: true }),
    );
    expect(el.scrollLeft).toBe(40);
  });

  it("deltaX + deltaY cộng dồn (chuyển chéo trackpad)", () => {
    render(
      <TopNavigationBar
        {...makeProps({
          folderHistory: LONG_HISTORY,
          currentFolderName: "current",
        })}
      />,
    );
    const el = getBreadcrumb();
    el.dispatchEvent(
      new WheelEvent("wheel", { deltaX: 30, deltaY: 70, cancelable: true }),
    );
    expect(el.scrollLeft).toBe(100);
  });

  it("click thuần (pointerdown không di chuyển) KHÔNG gọi setPointerCapture", () => {
    render(
      <TopNavigationBar
        {...makeProps({
          folderHistory: LONG_HISTORY,
          currentFolderName: "current",
        })}
      />,
    );
    const el = getBreadcrumb();
    const captureSpy = vi.fn();
    el.setPointerCapture = captureSpy;
    fireEvent.pointerDown(el, { clientX: 100, pointerId: 7 });
    expect(captureSpy).not.toHaveBeenCalled();
    expect(el.scrollLeft).toBe(0);
  });

  it("di chuyển dưới ngưỡng drag (5px) không bắt đầu drag", () => {
    render(
      <TopNavigationBar
        {...makeProps({
          folderHistory: LONG_HISTORY,
          currentFolderName: "current",
        })}
      />,
    );
    const el = getBreadcrumb();
    const captureSpy = vi.fn();
    el.setPointerCapture = captureSpy;
    fireEvent.pointerDown(el, { clientX: 100, pointerId: 8 });
    fireEvent.pointerMove(el, { clientX: 97, pointerId: 8 });
    expect(captureSpy).not.toHaveBeenCalled();
    expect(el.scrollLeft).toBe(0);
  });

  it("drag chuột cuộn ngang theo clientX, kết thúc khi pointerup", () => {
    render(
      <TopNavigationBar
        {...makeProps({
          folderHistory: LONG_HISTORY,
          currentFolderName: "current",
        })}
      />,
    );
    const el = getBreadcrumb();
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

  it("click breadcrumb vẫn hoạt động sau pointerdown/up không di chuyển", () => {
    const onBreadcrumbClick = vi.fn();
    render(
      <TopNavigationBar
        {...makeProps({
          folderHistory: [{ id: "f1", name: "Folder A" }],
          currentFolderName: "current",
          onBreadcrumbClick,
        })}
      />,
    );
    const el = getBreadcrumb();
    fireEvent.pointerDown(el, { clientX: 100, pointerId: 2 });
    fireEvent.pointerUp(el, { clientX: 100, pointerId: 2 });
    expect(el.scrollLeft).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Folder A" }));
    expect(onBreadcrumbClick).toHaveBeenCalledWith("f1", "Folder A", 0);
  });
});
