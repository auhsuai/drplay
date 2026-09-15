// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ThemeDropdown } from "./ThemeDropdown";

// No i18n instance in the node test env — return the key as the label so the
// trigger/menu items have deterministic accessible names.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("ThemeDropdown", () => {
  afterEach(() => {
    cleanup();
  });

  it("conveys the open state via aria-expanded", () => {
    render(<ThemeDropdown currentTheme="dark" onChange={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "settings.dark_mode" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(
      screen.getByRole("button", { name: "settings.light_mode" }),
    ).toBeTruthy();
  });

  it("Escape closes the menu and returns focus to the trigger", () => {
    render(<ThemeDropdown currentTheme="dark" onChange={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "settings.dark_mode" });
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(window, { key: "Escape" });

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(
      screen.queryByRole("button", { name: "settings.light_mode" }),
    ).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("selects a theme via onChange and closes the menu", () => {
    const onChange = vi.fn();
    render(<ThemeDropdown currentTheme="light" onChange={onChange} />);
    fireEvent.click(
      screen.getByRole("button", { name: "settings.light_mode" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "settings.system_mode" }),
    );

    expect(onChange).toHaveBeenCalledWith("system");
    expect(
      screen.queryByRole("button", { name: "settings.system_mode" }),
    ).toBeNull();
  });
});
