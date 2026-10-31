// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type React from "react";
import { TopNavigationBar } from "./TopNavigationBar";
import en from "../../../locales/en/translation.json";
import {
  VIRTUAL_ROOT_ID,
  VIRTUAL_ROOT_NAME,
} from "../../../utils/driveConstants";

// scope: TopNavigationBar's own remaining responsibilities. The sort dropdown
// used to live in this toolbar and was then removed app-wide (both My Drive
// and the Recent full views sort through FileListHeader instances now).
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
  showNewFolderButton?: boolean;
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

describe("TopNavigationBar toolbar (post-dropdown-removal)", () => {
  afterEach(() => {
    cleanup();
  });

  it("no longer renders a sort dropdown (sorting lives in FileListHeader)", () => {
    render(<TopNavigationBar {...makeProps()} />);
    expect(screen.queryByRole("button", { name: "Sort options" })).toBeNull();
    expect(screen.queryByTitle("Toggle order")).toBeNull();
    expect(screen.queryByTestId("sort-menu")).toBeNull();
  });

  it("names the search input for assistive tech", () => {
    render(<TopNavigationBar {...makeProps()} />);
    expect(screen.getByRole("textbox", { name: "Search..." })).toBeTruthy();
  });

  it("keeps the sortOption/onSortChange props accepted for call-site compatibility", () => {
    // The props stay in the interface (MainContent/TabContentRouter still
    // thread them to FileListHeader); rendering with them must not throw and
    // must not resurrect a toolbar sort control.
    const onSortChange = vi.fn();
    render(
      <TopNavigationBar
        {...makeProps({ sortOption: "modifiedTime desc", onSortChange })}
      />,
    );
    expect(screen.getByRole("textbox", { name: "Search..." })).toBeTruthy();
    expect(onSortChange).not.toHaveBeenCalled();
  });
});

describe("TopNavigationBar accessible names (P2-03-3 + P2-11 twins)", () => {
  afterEach(() => {
    cleanup();
  });

  it("clear search button has an accessible name and clears the query", () => {
    const onSearchChange = vi.fn();
    render(
      <TopNavigationBar
        {...makeProps({ searchQuery: "alpha", onSearchChange })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(onSearchChange).toHaveBeenCalledWith("");
  });

  it("back button has an accessible name", () => {
    render(<TopNavigationBar {...makeProps({ hasHistory: true })} />);
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
  });

  it("exit selection button has an accessible name and clears the selection", () => {
    const onClearSelection = vi.fn();
    render(
      <TopNavigationBar
        {...makeProps({
          isSelectionMode: true,
          selectedCount: 2,
          onClearSelection,
        })}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Exit selection mode" }),
    );
    expect(onClearSelection).toHaveBeenCalledTimes(1);
  });
});

describe("TopNavigationBar virtual root (multi-root)", () => {
  afterEach(() => {
    cleanup();
  });

  it("translates the virtual root name in breadcrumb and current title", () => {
    render(
      <TopNavigationBar
        {...makeProps({
          hasHistory: true,
          folderHistory: [{ id: VIRTUAL_ROOT_ID, name: VIRTUAL_ROOT_NAME }],
          currentFolderName: VIRTUAL_ROOT_NAME,
        })}
      />,
    );

    // en.drive.root_folders -> "Root Folders" for both breadcrumb and title.
    expect(screen.getAllByText("Root Folders")).toHaveLength(2);
    // The ids are identifiers only; neither the sentinel id nor the raw
    // translation key may leak into rendered text.
    expect(screen.queryByText(VIRTUAL_ROOT_ID)).toBeNull();
    expect(screen.queryByText("drive.root_folders")).toBeNull();
  });

  it("hides the New Folder button when showNewFolderButton is false", () => {
    render(<TopNavigationBar {...makeProps({ showNewFolderButton: false })} />);

    expect(screen.queryByText("New Folder")).toBeNull();
  });

  it("shows the New Folder button by default", () => {
    render(<TopNavigationBar {...makeProps()} />);

    expect(screen.getByText("New Folder")).toBeTruthy();
  });
});
