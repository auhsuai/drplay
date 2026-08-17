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
