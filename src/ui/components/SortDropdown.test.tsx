// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SortDropdown } from "./SortDropdown";
import { handleGlobalBack } from "../../hooks/useHardwareBack";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const OPTIONS = [
  { id: "name", label: "Name" },
  { id: "date", label: "Date", defaultDesc: true },
];

const baseProps = {
  sortOption: "name",
  onSortChange: vi.fn(),
  options: OPTIONS,
  fallbackLabel: "Sort",
};

describe("SortDropdown a11y fixes (Phase B 2026-08-25)", () => {
  afterEach(() => {
    cleanup();
  });

  it("does not nest interactive controls (trigger and arrow are siblings)", () => {
    const { container } = render(<SortDropdown {...baseProps} />);
    const roleButtons = container.querySelectorAll('[role="button"]');
    expect(roleButtons.length).toBe(2);

    const trigger = screen.getByLabelText("sort.menu");
    const arrow = container.querySelector(".arrow-btn") as HTMLElement;
    expect(trigger).toBeDefined();
    expect(arrow).toBeDefined();
    expect(trigger.contains(arrow)).toBe(false);
    expect(arrow.contains(trigger)).toBe(false);
  });

  it("clicking the arrow toggles desc without opening the menu", () => {
    const onSortChange = vi.fn();
    const { rerender } = render(
      <SortDropdown {...baseProps} onSortChange={onSortChange} />,
    );
    const arrow = document.querySelector(".arrow-btn") as HTMLElement;

    fireEvent.click(arrow);
    expect(onSortChange).toHaveBeenCalledWith("name desc");
    expect(screen.queryByTestId("sort-menu")).toBeNull();

    rerender(
      <SortDropdown
        {...baseProps}
        sortOption="name desc"
        onSortChange={onSortChange}
      />,
    );
    fireEvent.click(arrow);
    expect(onSortChange).toHaveBeenLastCalledWith("name");
    expect(screen.queryByTestId("sort-menu")).toBeNull();
  });

  it("keyboard Enter on the arrow toggles desc without opening the menu", () => {
    const onSortChange = vi.fn();
    render(<SortDropdown {...baseProps} onSortChange={onSortChange} />);
    const arrow = document.querySelector(".arrow-btn") as HTMLElement;

    fireEvent.keyDown(arrow, { key: "Enter" });
    expect(onSortChange).toHaveBeenCalledWith("name desc");
    expect(screen.queryByTestId("sort-menu")).toBeNull();
  });

  it("exposes listbox ARIA pattern (haspopup, controls, option roles)", () => {
    render(<SortDropdown {...baseProps} />);
    const trigger = screen.getByLabelText("sort.menu");
    expect(trigger.getAttribute("aria-haspopup")).toBe("listbox");
    expect(trigger.getAttribute("aria-controls")).toBe("sort-menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);
    const listbox = screen.getByRole("listbox");
    expect(listbox.id).toBe("sort-menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    const opts = screen.getAllByRole("option");
    expect(opts.map((o) => o.textContent)).toEqual(["Name", "Date"]);
    expect(opts[0]?.getAttribute("aria-selected")).toBe("true");
    expect(opts[1]?.getAttribute("aria-selected")).toBe("false");
  });

  it("selecting an option applies sort and closes the menu", () => {
    const onSortChange = vi.fn();
    render(<SortDropdown {...baseProps} onSortChange={onSortChange} />);
    fireEvent.click(screen.getByLabelText("sort.menu"));
    fireEvent.click(screen.getByRole("option", { name: "Date" }));
    expect(onSortChange).toHaveBeenCalledWith("date desc");
    expect(screen.queryByTestId("sort-menu")).toBeNull();
  });

  it("closes an open menu on Escape (desktop keyboard)", () => {
    render(<SortDropdown {...baseProps} />);
    fireEvent.click(screen.getByLabelText("sort.menu"));
    expect(screen.getByTestId("sort-menu")).not.toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("sort-menu")).toBeNull();
  });

  it("ignores Escape while closed and ignores other keys while open", () => {
    render(<SortDropdown {...baseProps} />);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("sort-menu")).toBeNull();

    fireEvent.click(screen.getByLabelText("sort.menu"));
    fireEvent.keyDown(document, { key: "Enter" });
    expect(screen.getByTestId("sort-menu")).not.toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("sort-menu")).toBeNull();
  });
});

describe("SortDropdown hardware-back closes the menu (batch fix 2026-08-17)", () => {
  afterEach(() => {
    cleanup();
  });

  function pressBack(): boolean {
    let consumed = false;
    act(() => {
      consumed = handleGlobalBack();
    });
    return consumed;
  }

  it("closes the menu when open (handleGlobalBack true, then false)", () => {
    render(<SortDropdown {...baseProps} />);
    expect(screen.queryByTestId("sort-menu")).toBeNull();

    fireEvent.click(screen.getByLabelText("sort.menu"));
    expect(screen.getByTestId("sort-menu")).not.toBeNull();

    expect(pressBack()).toBe(true);
    expect(screen.queryByTestId("sort-menu")).toBeNull();

    expect(pressBack()).toBe(false);
  });

  it("does not register the back handler while the menu is closed (no fall-through)", () => {
    render(<SortDropdown {...baseProps} />);
    expect(pressBack()).toBe(false);
  });

  it("removes the back handler on unmount (no leak across tests)", () => {
    const { unmount } = render(<SortDropdown {...baseProps} />);
    fireEvent.click(screen.getByLabelText("sort.menu"));
    expect(screen.getByTestId("sort-menu")).not.toBeNull();
    unmount();

    expect(pressBack()).toBe(false);
  });
});

describe("SortDropdown mobile chip visibility + contrast fix (2026-08-31)", () => {
  afterEach(() => {
    cleanup();
  });

  // jsdom does not apply responsive CSS, so visibility is asserted through
  // the Tailwind classes themselves (repo pattern for mobile-only bugs).
  it("shows the chip label container at every screen size (grid, not hidden)", () => {
    const { container } = render(<SortDropdown {...baseProps} />);
    const trigger = screen.getByLabelText("sort.menu");
    const labelWrap = trigger.querySelector("div") as HTMLElement;
    expect(labelWrap).not.toBeNull();
    expect(labelWrap.className).toContain("grid");
    expect(labelWrap.className).not.toContain("hidden");
    expect(container).toBeTruthy();
  });

  it("renders the current sort option label in the chip", () => {
    const { rerender } = render(<SortDropdown {...baseProps} />);
    const trigger = screen.getByLabelText("sort.menu");
    expect(trigger.textContent).toContain("Name");

    // NOTE: text was already present in the DOM before this fix (it was
    // merely visually hidden on mobile) — this assertion is a guard
    // against regression, not the fix itself.
    rerender(<SortDropdown {...baseProps} sortOption="date desc" />);
    expect(screen.getByLabelText("sort.menu").textContent).toContain("Date");
  });

  it("keeps the menu attached right below the chip (mt-1, not mt-2)", () => {
    render(<SortDropdown {...baseProps} />);
    fireEvent.click(screen.getByLabelText("sort.menu"));
    const menu = screen.getByTestId("sort-menu");
    expect(menu.className).toContain("mt-1");
    expect(menu.className).not.toContain("mt-2");
  });

  it("uses bright text on the gray chip for AA contrast", () => {
    render(<SortDropdown {...baseProps} />);
    const trigger = screen.getByLabelText("sort.menu");
    expect(trigger.className).toContain("text-white");
  });
});
