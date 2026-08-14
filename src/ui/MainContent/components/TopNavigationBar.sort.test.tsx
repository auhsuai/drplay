// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type React from "react";
import { TopNavigationBar } from "./TopNavigationBar";
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

const onSortChange = vi.fn();

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
    onSortChange,
    token: "token",
    onNewFolderClick: vi.fn(),
    isInitialMount: { current: true },
    searchInputRef: { current: null },
    ...overrides,
  };
}

const openSortMenu = () => {
  const arrow = screen.getByTitle("Toggle order");
  fireEvent.click(arrow.parentElement as HTMLElement);
};

describe("TopNavigationBar sort dropdown (contract guard)", () => {
  afterEach(() => {
    cleanup();
    onSortChange.mockReset();
  });

  it("shows the label of the current sort option", () => {
    render(<TopNavigationBar {...makeProps()} />);
    expect(screen.getAllByText("A-Z").length).toBeGreaterThan(0);
  });

  it("shows fallback label for an unknown sort option", () => {
    render(<TopNavigationBar {...makeProps({ sortOption: "name_natural" })} />);
    expect(screen.getAllByText("Sort").length).toBeGreaterThan(0);
  });

  it("opens a menu with exactly 3 options: A-Z / Date / Size", () => {
    render(<TopNavigationBar {...makeProps()} />);
    openSortMenu();
    const menu = document.querySelector(
      "[data-testid=sort-menu]",
    ) as HTMLElement;
    const labels = Array.from(menu.querySelectorAll("button")).map(
      (b) => b.textContent,
    );
    expect(labels.sort()).toEqual(["A-Z", "Date", "Size"]);
  });

  it('clicking Date sets "modifiedTime desc"', () => {
    render(<TopNavigationBar {...makeProps()} />);
    openSortMenu();
    fireEvent.click(screen.getByRole("button", { name: "Date" }));
    expect(onSortChange).toHaveBeenCalledWith("modifiedTime desc");
  });

  it('clicking A-Z sets "name"', () => {
    render(
      <TopNavigationBar {...makeProps({ sortOption: "modifiedTime desc" })} />,
    );
    openSortMenu();
    fireEvent.click(screen.getByRole("button", { name: "A-Z" }));
    expect(onSortChange).toHaveBeenCalledWith("name");
  });

  it('clicking Size sets "size"', () => {
    render(<TopNavigationBar {...makeProps()} />);
    openSortMenu();
    fireEvent.click(screen.getByRole("button", { name: "Size" }));
    expect(onSortChange).toHaveBeenCalledWith("size");
  });

  it('arrow toggle appends/removes " desc" and does not open the menu', () => {
    render(<TopNavigationBar {...makeProps()} />);
    fireEvent.click(screen.getByTitle("Toggle order"));
    expect(onSortChange).toHaveBeenCalledWith("name desc");
    expect(screen.queryByRole("button", { name: "A-Z" })).toBeNull();
  });

  it('arrow toggle removes " desc" when already descending', () => {
    render(<TopNavigationBar {...makeProps({ sortOption: "name desc" })} />);
    fireEvent.click(screen.getByTitle("Toggle order"));
    expect(onSortChange).toHaveBeenCalledWith("name");
  });

  it("renders no sort UI when token is null", () => {
    render(<TopNavigationBar {...makeProps({ token: null })} />);
    expect(screen.queryByTitle("Toggle order")).toBeNull();
  });
});
