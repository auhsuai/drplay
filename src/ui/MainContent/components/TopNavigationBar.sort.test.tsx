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
  fireEvent.click(screen.getByRole("button", { name: "Sort options" }));
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
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Date" }));
    expect(onSortChange).toHaveBeenCalledWith("modifiedTime desc");
  });

  it('clicking A-Z sets "name"', () => {
    render(
      <TopNavigationBar {...makeProps({ sortOption: "modifiedTime desc" })} />,
    );
    openSortMenu();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "A-Z" }));
    expect(onSortChange).toHaveBeenCalledWith("name");
  });

  it('clicking Size sets "size"', () => {
    render(<TopNavigationBar {...makeProps()} />);
    openSortMenu();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Size" }));
    expect(onSortChange).toHaveBeenCalledWith("size");
  });

  it('arrow toggle appends/removes " desc" and does not open the menu', () => {
    render(<TopNavigationBar {...makeProps()} />);
    fireEvent.click(screen.getByTitle("Toggle order"));
    expect(onSortChange).toHaveBeenCalledWith("name desc");
    expect(screen.queryByRole("menuitemradio", { name: "A-Z" })).toBeNull();
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

  it("names the search input for assistive tech", () => {
    render(<TopNavigationBar {...makeProps()} />);
    expect(screen.getByRole("textbox", { name: "Search..." })).toBeTruthy();
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

describe("TopNavigationBar sort dropdown APG (P2-13a-8)", () => {
  afterEach(() => {
    cleanup();
    onSortChange.mockReset();
  });

  it("trigger announces a menu and opening places focus on the first option", () => {
    render(<TopNavigationBar {...makeProps()} />);
    const trigger = screen.getByRole("button", { name: "Sort options" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");

    fireEvent.click(trigger);
    expect(document.activeElement).toBe(
      screen.getByRole("menuitemradio", { name: "A-Z" }),
    );
  });

  it("marks only the active option as checked", () => {
    render(
      <TopNavigationBar {...makeProps({ sortOption: "modifiedTime desc" })} />,
    );
    openSortMenu();

    expect(
      screen.getByRole("menuitemradio", { name: "Date", checked: true }),
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitemradio", { name: "A-Z", checked: false }),
    ).toBeTruthy();
  });

  it("Escape closes the menu and returns focus to the trigger", () => {
    render(<TopNavigationBar {...makeProps()} />);
    openSortMenu();

    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: "Escape",
    });

    expect(screen.queryByTestId("sort-menu")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Sort options" }),
    );
  });

  it("ArrowDown roves focus through the options and wraps around", () => {
    render(<TopNavigationBar {...makeProps()} />);
    openSortMenu();

    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: "ArrowDown",
    });
    expect(document.activeElement).toBe(
      screen.getByRole("menuitemradio", { name: "Date" }),
    );

    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: "ArrowDown",
    });
    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: "ArrowDown",
    });
    expect(document.activeElement).toBe(
      screen.getByRole("menuitemradio", { name: "A-Z" }),
    );
  });

  it("selecting an option closes the menu and returns focus to the trigger", () => {
    render(<TopNavigationBar {...makeProps()} />);
    openSortMenu();

    fireEvent.click(screen.getByRole("menuitemradio", { name: "Size" }));

    expect(screen.queryByTestId("sort-menu")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Sort options" }),
    );
  });
});
