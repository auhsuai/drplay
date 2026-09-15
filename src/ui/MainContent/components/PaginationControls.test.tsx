// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { PaginationControls } from "./PaginationControls";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function baseProps(
  over: Partial<Parameters<typeof PaginationControls>[0]> = {},
) {
  return {
    currentPage: 3,
    totalPages: 10,
    setCurrentPage: vi.fn(),
    onScrollTop: vi.fn(),
    ...over,
  };
}

function renderControls(
  over: Partial<Parameters<typeof PaginationControls>[0]> = {},
) {
  const props = baseProps(over);
  const { container } = render(<PaginationControls {...props} />);
  const input = container.querySelector("input");
  if (!input) throw new Error("page input not rendered");
  return { props, input, container };
}

describe("PaginationControls page-edit keyboard (P2-04-5)", () => {
  afterEach(() => {
    cleanup();
  });

  it("Enter after cancelling an edit does not commit the cancelled page", () => {
    const { props, input } = renderControls();
    // Pointer path into edit mode: click the control, type, then cancel.
    fireEvent.click(input);
    fireEvent.change(input, { target: { value: "7" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(props.setCurrentPage).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.setCurrentPage).not.toHaveBeenCalled();
  });

  it("Enter while editing still commits the typed page", () => {
    const { props, input } = renderControls();
    fireEvent.click(input);
    fireEvent.change(input, { target: { value: "7" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.setCurrentPage).toHaveBeenCalledWith(7);
  });

  it("discards out-of-range values without committing", () => {
    const { props, input } = renderControls();
    fireEvent.click(input);
    fireEvent.change(input, { target: { value: "999" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.setCurrentPage).not.toHaveBeenCalled();
  });
});

describe("PaginationControls single accessible control (P2-04-6)", () => {
  afterEach(() => {
    cleanup();
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });

  it("has no nested role=button wrapper and a labelled input", () => {
    const { container } = renderControls();
    expect(container.querySelector('[role="button"]')).toBeNull();
    expect(container.querySelector('[tabindex="0"]')).toBeNull();
    expect(screen.getByLabelText("pagination.page")).toBeTruthy();
  });

  it("Enter/Space on the focused input starts editing (keyboard access)", () => {
    const { input } = renderControls();
    input.focus();
    expect(input.readOnly).toBe(true);

    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.readOnly).toBe(false);
    expect(input.value).toBe("3");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.readOnly).toBe(true);

    fireEvent.keyDown(input, { key: " " });
    expect(input.readOnly).toBe(false);
  });
});
