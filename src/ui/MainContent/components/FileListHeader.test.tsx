// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { FileListHeader } from "./FileListHeader";

// Column-header sort state machine mirrors the Trash screen (TrashScreen.test
// "Trash header sorting"): aria-sort lives on the columnheader wrapper, a
// click on an inactive column applies that column's default direction, a
// click on the active column toggles the " desc" suffix.
describe("FileListHeader sorting", () => {
  afterEach(() => {
    cleanup();
  });

  it("default modifiedTime desc: Date column aria-sort=descending with indicator, others none", () => {
    render(
      <FileListHeader sortOption="modifiedTime desc" onSortChange={vi.fn()} />,
    );

    expect(
      screen.getByRole("columnheader", { name: "drive.col_name" }),
    ).toHaveAttribute("aria-sort", "none");
    expect(
      screen.getByRole("columnheader", { name: "drive.col_date_modified" }),
    ).toHaveAttribute("aria-sort", "descending");
    expect(
      screen.getByRole("columnheader", { name: "drive.col_size" }),
    ).toHaveAttribute("aria-sort", "none");

    // Exactly one blue-disc indicator (on the active column only).
    expect(
      document.querySelectorAll(".bg-brand-primary.rounded-full"),
    ).toHaveLength(1);
  });

  it("click Name (inactive) applies ascending default: onSortChange('name')", () => {
    const onSortChange = vi.fn();
    render(
      <FileListHeader
        sortOption="modifiedTime desc"
        onSortChange={onSortChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "drive.col_name" }));
    expect(onSortChange).toHaveBeenCalledWith("name");
  });

  it("click Name (active asc) toggles to desc: onSortChange('name desc')", () => {
    const onSortChange = vi.fn();
    render(<FileListHeader sortOption="name" onSortChange={onSortChange} />);

    fireEvent.click(screen.getByRole("button", { name: "drive.col_name" }));
    expect(onSortChange).toHaveBeenCalledWith("name desc");
  });

  it("click Size (inactive) applies largest-first default: onSortChange('size desc')", () => {
    const onSortChange = vi.fn();
    render(<FileListHeader sortOption="name" onSortChange={onSortChange} />);

    fireEvent.click(screen.getByRole("button", { name: "drive.col_size" }));
    expect(onSortChange).toHaveBeenCalledWith("size desc");
  });

  it("click Size (active desc) toggles to asc: onSortChange('size')", () => {
    const onSortChange = vi.fn();
    render(
      <FileListHeader sortOption="size desc" onSortChange={onSortChange} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "drive.col_size" }));
    expect(onSortChange).toHaveBeenCalledWith("size");
  });

  it("click Date (inactive) applies newest-first default: onSortChange('modifiedTime desc')", () => {
    const onSortChange = vi.fn();
    render(<FileListHeader sortOption="name" onSortChange={onSortChange} />);

    fireEvent.click(
      screen.getByRole("button", { name: "drive.col_date_modified" }),
    );
    expect(onSortChange).toHaveBeenCalledWith("modifiedTime desc");
  });

  it("unknown sortOption (garbage LS value): all columns aria-sort=none, no indicator", () => {
    render(<FileListHeader sortOption="name_natural" onSortChange={vi.fn()} />);

    for (const label of [
      "drive.col_name",
      "drive.col_date_modified",
      "drive.col_size",
    ]) {
      expect(screen.getByRole("columnheader", { name: label })).toHaveAttribute(
        "aria-sort",
        "none",
      );
    }
    expect(
      document.querySelectorAll(".bg-brand-primary.rounded-full"),
    ).toHaveLength(0);
  });

  it("renders columnheader wrappers even without onSortChange (defensive, buttons still present)", () => {
    render(<FileListHeader sortOption="modifiedTime desc" />);

    expect(
      screen.getByRole("columnheader", { name: "drive.col_date_modified" }),
    ).toHaveAttribute("aria-sort", "descending");
    // The buttons are the keyboard-activatable controls; the guard lives at
    // the MainContent render site (only mounted when a callback is wired).
    expect(
      screen.getByRole("button", { name: "drive.col_date_modified" }),
    ).not.toBeNull();
  });

  it("dateLabel prop overrides the Date column label (Recent view 'Last played')", () => {
    render(
      <FileListHeader
        sortOption="modifiedTime desc"
        onSortChange={vi.fn()}
        dateLabel="Last played"
      />,
    );

    expect(screen.getByRole("button", { name: "Last played" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "drive.col_date_modified" }),
    ).toBeNull();
  });

  it("without dateLabel the Date column keeps the My Drive label (default untouched)", () => {
    render(<FileListHeader sortOption="modifiedTime desc" />);

    expect(
      screen.getByRole("button", { name: "drive.col_date_modified" }),
    ).toBeTruthy();
  });
});
