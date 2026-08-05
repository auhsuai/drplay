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
  const arrow = screen.getByTitle("Toggle Order");
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

  it("opens a menu with exactly 3 options: A-Z / Ngày / Kích thước", () => {
    render(<TopNavigationBar {...makeProps()} />);
    openSortMenu();
    const menu = document.querySelector(".w-32") as HTMLElement;
    const labels = Array.from(menu.querySelectorAll("button")).map(
      (b) => b.textContent,
    );
    expect(labels.sort()).toEqual(["A-Z", "Kích thước", "Ngày"]);
  });

  it('clicking Ngày sets "modifiedTime desc"', () => {
    render(<TopNavigationBar {...makeProps()} />);
    openSortMenu();
    fireEvent.click(screen.getByRole("button", { name: "Ngày" }));
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

  it('clicking Kích thước sets "size"', () => {
    render(<TopNavigationBar {...makeProps()} />);
    openSortMenu();
    fireEvent.click(screen.getByRole("button", { name: "Kích thước" }));
    expect(onSortChange).toHaveBeenCalledWith("size");
  });

  it('arrow toggle appends/removes " desc" and does not open the menu', () => {
    render(<TopNavigationBar {...makeProps()} />);
    fireEvent.click(screen.getByTitle("Toggle Order"));
    expect(onSortChange).toHaveBeenCalledWith("name desc");
    expect(screen.queryByRole("button", { name: "A-Z" })).toBeNull();
  });

  it('arrow toggle removes " desc" when already descending', () => {
    render(<TopNavigationBar {...makeProps({ sortOption: "name desc" })} />);
    fireEvent.click(screen.getByTitle("Toggle Order"));
    expect(onSortChange).toHaveBeenCalledWith("name");
  });

  it("renders no sort UI when token is null", () => {
    render(<TopNavigationBar {...makeProps({ token: null })} />);
    expect(screen.queryByTitle("Toggle Order")).toBeNull();
  });
});
