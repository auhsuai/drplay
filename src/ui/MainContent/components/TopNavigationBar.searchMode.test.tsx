// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type React from "react";
import { TopNavigationBar } from "./TopNavigationBar";
import en from "../../../locales/en/translation.json";

// Phase B tests: search mode toggle button in the search input's left gutter
// (globe = global, Tabler folders = recursive). With mode props wired the
// mode icon shows in EVERY query state (empty included) and stays clickable;
// the decorative magnifier remains only for callers that do not wire the
// mode props (backward compat).
//
// react-i18next has no initialized instance in the node test env (i18n.ts
// touches localStorage at import time), so we stub useTranslation to resolve
// keys against the real en resources — same pattern as TopNavigationBar.sort.
vi.mock("react-i18next", () => {
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
  searchMode?: "global" | "recursive";
  onToggleSearchMode?: () => void;
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

describe("TopNavigationBar search mode toggle (Phase B)", () => {
  afterEach(() => {
    cleanup();
  });

  it("empty query + mode props wired: mode icon shows as a clickable toggle (Globe when global) — user feedback 2026-10-31", () => {
    // User feedback: empty search must ALREADY show the current mode icon
    // (Globe for global, folders for recursive), still a toggle button.
    // The old decorative-magnifier-on-empty behavior is gone for wired
    // callers; it survives only when the mode props are absent.
    render(
      <TopNavigationBar
        {...makeProps({
          searchQuery: "",
          searchMode: "global",
          onToggleSearchMode: vi.fn(),
        })}
      />,
    );

    const button = screen.getByRole("button", {
      name: "Switch to recursive search",
    });
    expect(button).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Switch to global search" }),
    ).toBeNull();
    expect(document.querySelector(".lucide-globe")).not.toBeNull();
    expect(document.querySelector(".lucide-search")).toBeNull();
  });

  it("empty query + recursive mode: folders toggle shown (mode icon in the empty state too)", () => {
    render(
      <TopNavigationBar
        {...makeProps({
          searchQuery: "",
          searchMode: "recursive",
          onToggleSearchMode: vi.fn(),
        })}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Switch to global search" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Switch to recursive search" }),
    ).toBeNull();
    expect(
      document.querySelector(
        'svg[class*="w-4"][class*="h-4"]:not([class*="lucide"])',
      ),
    ).not.toBeNull();
  });

  it("empty query + NO mode props: decorative Search icon only (backward compat)", () => {
    render(<TopNavigationBar {...makeProps({ searchQuery: "" })} />);

    expect(
      screen.queryByRole("button", { name: "Switch to recursive search" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Switch to global search" }),
    ).toBeNull();
    expect(document.querySelector(".lucide-search")).not.toBeNull();
  });

  it("whitespace-only query + wired: mode icon STILL the toggle (trim-empty behaves like empty)", () => {
    render(
      <TopNavigationBar
        {...makeProps({
          searchQuery: "   ",
          searchMode: "global",
          onToggleSearchMode: vi.fn(),
        })}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Switch to recursive search" }),
    ).toBeTruthy();
    expect(document.querySelector(".lucide-search")).toBeNull();
  });

  it("REGRESSION (icon vanishes on focus): empty+global renders the mode icon that stacks ABOVE the input (z-10) so the focused input's own paint can never cover it", () => {
    // User bug (2026-10-31): clicking the search box (or Ctrl+F with an empty
    // query) made the icon disappear on the real app — the input was painted
    // over the positioned-but-unstacked icon once the focus ring rendered.
    // The toggle button carries an explicit z-10 (above the input's z-auto)
    // in every wired branch; the decorative magnifier keeps its own z-10.
    const { rerender } = render(
      <TopNavigationBar
        {...makeProps({
          searchQuery: "",
          searchMode: "global",
          onToggleSearchMode: vi.fn(),
        })}
      />,
    );
    const button = screen.getByRole("button", {
      name: "Switch to recursive search",
    });
    expect(button.className).toContain("z-10");

    // Focus the input (the exact user gesture): icon must STILL be present
    // and still stacked above the focused input (jsdom has no paint order,
    // so the class contract is what we can pin; the real-app fix is z-10).
    const input = screen.getByRole("textbox", { name: "Search..." });
    input.focus();
    expect(document.activeElement).toBe(input);

    // Mode flips via the parent: folders icon replaces Globe, still z-10.
    rerender(
      <TopNavigationBar
        {...makeProps({
          searchQuery: "",
          searchMode: "recursive",
          onToggleSearchMode: vi.fn(),
        })}
      />,
    );
    const foldersButton = screen.getByRole("button", {
      name: "Switch to global search",
    });
    expect(foldersButton.className).toContain("z-10");
  });

  it("mode props absent with a non-empty query: keeps the decorative Search icon (old callers unaffected)", () => {
    render(<TopNavigationBar {...makeProps({ searchQuery: "alpha" })} />);

    expect(
      screen.queryByRole("button", { name: "Switch to recursive search" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Switch to global search" }),
    ).toBeNull();
    expect(document.querySelector(".lucide-search")).not.toBeNull();
  });

  it("global mode + non-empty query: Globe toggle button labelled 'Switch to recursive search'", () => {
    render(
      <TopNavigationBar
        {...makeProps({
          searchQuery: "alpha",
          searchMode: "global",
          onToggleSearchMode: vi.fn(),
        })}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Switch to recursive search" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Switch to global search" }),
    ).toBeNull();
    expect(document.querySelector(".lucide-globe")).not.toBeNull();
    // Decorative magnifier is gone while the toggle owns the gutter.
    expect(document.querySelector(".lucide-search")).toBeNull();
  });

  it("recursive mode + non-empty query: folders SVG toggle labelled 'Switch to global search'", () => {
    render(
      <TopNavigationBar
        {...makeProps({
          searchQuery: "alpha",
          searchMode: "recursive",
          onToggleSearchMode: vi.fn(),
        })}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Switch to global search" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Switch to recursive search" }),
    ).toBeNull();
    // Pinned Tabler folders artwork (not a lucide icon class).
    expect(
      document.querySelector(
        'svg[class*="w-4"][class*="h-4"]:not([class*="lucide"])',
      ),
    ).not.toBeNull();
  });

  it("click toggles mode and NEVER touches the query (title matches the accessible name)", () => {
    const onToggleSearchMode = vi.fn();
    const onSearchChange = vi.fn();
    render(
      <TopNavigationBar
        {...makeProps({
          searchQuery: "alpha",
          searchMode: "global",
          onToggleSearchMode,
          onSearchChange,
        })}
      />,
    );

    const button = screen.getByRole("button", {
      name: "Switch to recursive search",
    });
    expect(button.getAttribute("title")).toBe("Switch to recursive search");
    fireEvent.click(button);

    expect(onToggleSearchMode).toHaveBeenCalledTimes(1);
    expect(onSearchChange).not.toHaveBeenCalled();
  });

  it("empty+whitespace toggle: click switches mode and NEVER touches the query", () => {
    const onToggleSearchMode = vi.fn();
    const onSearchChange = vi.fn();
    render(
      <TopNavigationBar
        {...makeProps({
          searchQuery: "",
          searchMode: "recursive",
          onToggleSearchMode,
          onSearchChange,
        })}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Switch to global search" }),
    );
    expect(onToggleSearchMode).toHaveBeenCalledTimes(1);
    expect(onSearchChange).not.toHaveBeenCalled();
  });
});
