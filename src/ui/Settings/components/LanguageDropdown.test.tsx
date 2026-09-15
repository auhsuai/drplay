// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { LanguageDropdown } from "./LanguageDropdown";
import { LANGUAGE_KEY } from "../../../utils/storageKeys";

const changeLanguageMock = vi.hoisted(() =>
  vi.fn<(code: string) => Promise<void>>().mockResolvedValue(undefined),
);

// No i18n instance in the node test env — return the key as the label so the
// trigger/menu items have deterministic accessible names.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: changeLanguageMock },
  }),
}));

vi.mock("../../../utils/errorLog", () => ({ captureError: vi.fn() }));

describe("LanguageDropdown", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    changeLanguageMock.mockClear();
    localStorage.clear();
  });

  it("conveys the open state via aria-expanded", () => {
    render(<LanguageDropdown />);
    const trigger = screen.getByRole("button", { name: "settings.english" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(
      screen.getByRole("button", { name: "settings.vietnamese" }),
    ).toBeTruthy();
  });

  it("Escape closes the menu and returns focus to the trigger", () => {
    render(<LanguageDropdown />);
    const trigger = screen.getByRole("button", { name: "settings.english" });
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(window, { key: "Escape" });

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(
      screen.queryByRole("button", { name: "settings.vietnamese" }),
    ).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("selects a language, persists it and closes the menu", () => {
    render(<LanguageDropdown />);
    fireEvent.click(screen.getByRole("button", { name: "settings.english" }));
    fireEvent.click(
      screen.getByRole("button", { name: "settings.vietnamese" }),
    );

    expect(changeLanguageMock).toHaveBeenCalledWith("vi");
    expect(localStorage.getItem(LANGUAGE_KEY)).toBe("vi");
    expect(
      screen.queryByRole("button", { name: "settings.vietnamese" }),
    ).toBeNull();
  });
});
