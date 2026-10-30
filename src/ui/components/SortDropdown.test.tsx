// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SortDropdown } from "./SortDropdown";
import en from "../../locales/en/translation.json";

// Direct SortDropdown coverage. The My Drive toolbar no longer renders this
// component (FileListHeader owns its sorting), but the Recent tab's
// FullRecentView still does — so the component keeps shipping and its APG
// menu-button behavior must stay pinned. Tests here mount SortDropdown
// directly instead of going through a host toolbar.
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

const OPTIONS = [
  { id: "name", label: "A-Z" },
  { id: "modifiedTime", label: "Date", defaultDesc: true },
  { id: "size", label: "Size" },
];

function renderDropdown(
  overrides: {
    sortOption?: string;
    onSortChange?: (option: string) => void;
    fallbackLabel?: string;
  } = {},
) {
  const onSortChange = overrides.onSortChange ?? vi.fn();
  const view = render(
    <SortDropdown
      sortOption={overrides.sortOption ?? "name"}
      onSortChange={onSortChange}
      options={OPTIONS}
      fallbackLabel={overrides.fallbackLabel ?? "Sort"}
      isInitialMount={{ current: true }}
    />,
  );
  return { onSortChange, view };
}

const openMenu = () => {
  fireEvent.click(screen.getByRole("button", { name: "Sort options" }));
};

describe("SortDropdown contract (still used by FullRecentView)", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows the label of the current sort option", () => {
    renderDropdown();
    expect(screen.getAllByText("A-Z").length).toBeGreaterThan(0);
  });

  it("shows the fallback label for an unknown sort option", () => {
    renderDropdown({ sortOption: "name_natural" });
    expect(screen.getAllByText("Sort").length).toBeGreaterThan(0);
  });

  it("opens a menu with exactly 3 options: A-Z / Date / Size", () => {
    renderDropdown();
    openMenu();
    const menu = screen.getByTestId("sort-menu");
    const labels = Array.from(menu.querySelectorAll("button")).map(
      (b) => b.textContent,
    );
    expect(labels.sort()).toEqual(["A-Z", "Date", "Size"]);
  });

  it('clicking Date applies its defaultDesc: "modifiedTime desc"', () => {
    const { onSortChange } = renderDropdown();
    openMenu();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Date" }));
    expect(onSortChange).toHaveBeenCalledWith("modifiedTime desc");
  });

  it('clicking A-Z sets "name"', () => {
    const { onSortChange } = renderDropdown({
      sortOption: "modifiedTime desc",
    });
    openMenu();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "A-Z" }));
    expect(onSortChange).toHaveBeenCalledWith("name");
  });

  it('clicking Size sets "size" (asc; the header is a separate entry point)', () => {
    const { onSortChange } = renderDropdown();
    openMenu();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Size" }));
    expect(onSortChange).toHaveBeenCalledWith("size");
  });

  it('arrow toggle appends " desc" and does not open the menu', () => {
    const { onSortChange } = renderDropdown();
    fireEvent.click(screen.getByTitle("Toggle order"));
    expect(onSortChange).toHaveBeenCalledWith("name desc");
    expect(screen.queryByRole("menuitemradio", { name: "A-Z" })).toBeNull();
  });

  it('arrow toggle removes " desc" when already descending', () => {
    const { onSortChange } = renderDropdown({ sortOption: "name desc" });
    fireEvent.click(screen.getByTitle("Toggle order"));
    expect(onSortChange).toHaveBeenCalledWith("name");
  });
});

describe("SortDropdown APG menu-button behavior", () => {
  afterEach(() => {
    cleanup();
  });

  it("trigger announces a menu and opening places focus on the first option", () => {
    renderDropdown();
    const trigger = screen.getByRole("button", { name: "Sort options" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    openMenu();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(
      screen.getByRole("menuitemradio", { name: "A-Z" }),
    );
  });

  it("marks only the active option as checked", () => {
    renderDropdown({ sortOption: "modifiedTime desc" });
    openMenu();

    expect(
      screen.getByRole("menuitemradio", { name: "Date", checked: true }),
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitemradio", { name: "A-Z", checked: false }),
    ).toBeTruthy();
  });

  it("Escape closes the menu and returns focus to the trigger", () => {
    renderDropdown();
    openMenu();

    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: "Escape",
    });

    expect(screen.queryByTestId("sort-menu")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Sort options" }),
    );
  });

  it("ArrowDown roves focus through the options and wraps around", () => {
    renderDropdown();
    openMenu();

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
    renderDropdown();
    openMenu();

    fireEvent.click(screen.getByRole("menuitemradio", { name: "Size" }));

    expect(screen.queryByTestId("sort-menu")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Sort options" }),
    );
  });
});
