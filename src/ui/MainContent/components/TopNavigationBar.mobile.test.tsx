// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  act,
  createEvent,
  render,
  screen,
  fireEvent,
  cleanup,
} from "@testing-library/react";
import type React from "react";
import { TopNavigationBar } from "./TopNavigationBar";
import { handleGlobalBack } from "../../../hooks/useHardwareBack";
import en from "../../../locales/en/translation.json";

// react-i18next has no initialized instance in the node test env (i18n.ts
// touches localStorage at import time), so we stub useTranslation to return
// the defaultValue passed to t().
vi.mock("react-i18next", () => {
  // Resolve keys against the real en resources so assertions read the
  // shipped copy instead of hard-coded fallbacks.
  const resolveKey = (key: string): string | undefined => {
    let acc: unknown = en;
    for (const part of key.split(".")) {
      if (typeof acc === "object" && acc !== null) {
        acc = (acc as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }
    return typeof acc === "string" ? acc : undefined;
  };
  return {
    useTranslation: () => ({
      t: (key: string, defaultValue?: string) =>
        resolveKey(key) ?? defaultValue ?? key,
    }),
  };
});

// IS_MOBILE is read inside the component body (render time), so a
// getter-backed mock lets tests flip the platform mid-suite. Default desktop
// so unrelated suites that render TopNavigationBar keep the desktop path.
const platformMock = vi.hoisted(() => ({ IS_MOBILE: false }));
vi.mock("../../../utils/platform", () => ({
  get IS_MOBILE() {
    return platformMock.IS_MOBILE;
  },
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

describe("TopNavigationBar mobile search (IS_MOBILE)", () => {
  afterEach(() => {
    cleanup();
    platformMock.IS_MOBILE = false;
  });

  it("collapsed by default: only the search icon renders, no input", () => {
    platformMock.IS_MOBILE = true;
    render(<TopNavigationBar {...makeProps()} />);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByTestId("mobile-search-collapsed")).toBeTruthy();
  });

  it("tap icon → full-width expanded input with autofocus", () => {
    platformMock.IS_MOBILE = true;
    render(<TopNavigationBar {...makeProps()} />);
    fireEvent.click(screen.getByTestId("mobile-search-collapsed"));
    const input = screen.getByRole("textbox");
    expect(screen.getByTestId("mobile-search-expanded")).toBeTruthy();
    expect(input).toHaveFocus();
  });

  it("close button collapses and clears the query", () => {
    platformMock.IS_MOBILE = true;
    const onSearchChange = vi.fn();
    render(
      <TopNavigationBar
        {...makeProps({ searchQuery: "abc", onSearchChange })}
      />,
    );
    fireEvent.click(screen.getByTestId("mobile-search-collapsed"));
    fireEvent.click(screen.getByRole("button", { name: "Close search" }));
    expect(onSearchChange).toHaveBeenCalledWith("");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("blur collapses the expanded search", () => {
    platformMock.IS_MOBILE = true;
    render(<TopNavigationBar {...makeProps()} />);
    fireEvent.click(screen.getByTestId("mobile-search-collapsed"));
    fireEvent.blur(screen.getByRole("textbox"));
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  // Blur-vs-click race: a touch tap on the close button blurs the focused
  // input BEFORE the click lands; the onBlur collapse unmounts the row and
  // the click dies on a detached node, so the stale query keeps filtering.
  // Cancelling the down-events' default stops the focus shift while click
  // still fires (w3.org/TR/pointerevents4 §11), so the query must be cleared.
  it("tap close while focused still clears the query (mousedown default cancelled)", () => {
    platformMock.IS_MOBILE = true;
    const onSearchChange = vi.fn();
    render(
      <TopNavigationBar
        {...makeProps({ searchQuery: "abc", onSearchChange })}
      />,
    );
    fireEvent.click(screen.getByTestId("mobile-search-collapsed"));
    const input = screen.getByRole("textbox");
    const btn = screen.getByRole("button", { name: "Close search" });
    const ev = createEvent.mouseDown(btn);
    const pd = vi.spyOn(ev, "preventDefault");
    fireEvent(btn, ev);
    if (pd.mock.calls.length === 0) fireEvent.blur(input); // real browser would blur here
    fireEvent.click(btn);
    expect(onSearchChange).toHaveBeenLastCalledWith("");
  });

  it("mouseDown on the close button calls preventDefault", () => {
    platformMock.IS_MOBILE = true;
    render(<TopNavigationBar {...makeProps()} />);
    fireEvent.click(screen.getByTestId("mobile-search-collapsed"));
    const btn = screen.getByRole("button", { name: "Close search" });
    const ev = createEvent.mouseDown(btn);
    const pd = vi.spyOn(ev, "preventDefault");
    fireEvent(btn, ev);
    expect(pd).toHaveBeenCalled();
  });

  // Task 15: Android hardware back while the mobile search is expanded must
  // close the search and CONSUME the press — the search handler has to win
  // over App's My Drive folder-up handler (registered in a parent component,
  // so it would otherwise be checked first by LIFO and navigate to the
  // parent folder instead of collapsing the search).
  it("hardware back while expanded closes search and consumes the press", () => {
    platformMock.IS_MOBILE = true;
    render(<TopNavigationBar {...makeProps()} />);
    fireEvent.click(screen.getByTestId("mobile-search-collapsed"));
    expect(screen.getByTestId("mobile-search-expanded")).toBeTruthy();

    let handled = false;
    act(() => {
      handled = handleGlobalBack();
    });

    expect(handled).toBe(true);
    expect(screen.queryByTestId("mobile-search-expanded")).toBeNull();
    expect(screen.getByTestId("mobile-search-collapsed")).toBeTruthy();
  });

  it("hardware back with search collapsed does not consume the press (chain falls through)", () => {
    platformMock.IS_MOBILE = true;
    render(<TopNavigationBar {...makeProps()} />);

    expect(handleGlobalBack()).toBe(false);
    expect(screen.getByTestId("mobile-search-collapsed")).toBeTruthy();
  });

  it("breadcrumb shows only the current folder on mobile (path hidden)", () => {
    platformMock.IS_MOBILE = true;
    render(
      <TopNavigationBar
        {...makeProps({
          folderHistory: [
            { id: "a", name: "Folder A" },
            { id: "b", name: "Folder B" },
          ],
          currentFolderName: "Current",
        })}
      />,
    );
    expect(screen.getByText("Current")).toBeTruthy();
    expect(screen.queryByText("Folder A")).toBeNull();
    expect(screen.queryByText("Folder B")).toBeNull();
  });

  it("desktop unchanged: full input + full breadcrumb history", () => {
    platformMock.IS_MOBILE = false;
    render(
      <TopNavigationBar
        {...makeProps({
          folderHistory: [{ id: "a", name: "Folder A" }],
          currentFolderName: "Current",
        })}
      />,
    );
    expect(screen.getByRole("textbox")).toBeTruthy();
    expect(screen.getByText("Folder A")).toBeTruthy();
    expect(screen.getByText("Current")).toBeTruthy();
    expect(screen.queryByTestId("mobile-search-collapsed")).toBeNull();
  });
});
