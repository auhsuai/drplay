// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeDropdown } from "./ThemeDropdown";
import { handleGlobalBack } from "../../../hooks/useHardwareBack";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("ThemeDropdown hardware-back closes the menu (batch fix 2026-08-17)", () => {
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

  function trigger(): HTMLElement {
    // The trigger shows the current theme label (settings.light_mode / dark_mode / system_mode).
    // The default ThemeType is "dark", so the trigger renders "settings.dark_mode".
    return screen.getByRole("button", { name: /settings\.dark_mode/ });
  }

  it("closes the menu when open (handleGlobalBack true, then false)", () => {
    render(<ThemeDropdown currentTheme="dark" onChange={vi.fn()} />);
    fireEvent.click(trigger());
    // Trigger + Dark option visible.
    expect(
      screen.getAllByRole("button", { name: /settings\.dark_mode/ }),
    ).toHaveLength(2);

    expect(pressBack()).toBe(true);
    expect(
      screen.getAllByRole("button", { name: /settings\.dark_mode/ }),
    ).toHaveLength(1);

    expect(pressBack()).toBe(false);
  });

  it("does not register the back handler while the menu is closed (no fall-through)", () => {
    render(<ThemeDropdown currentTheme="dark" onChange={vi.fn()} />);
    expect(pressBack()).toBe(false);
  });

  it("removes the back handler on unmount (no leak across tests)", () => {
    const { unmount } = render(
      <ThemeDropdown currentTheme="dark" onChange={vi.fn()} />,
    );
    fireEvent.click(trigger());
    unmount();

    expect(pressBack()).toBe(false);
  });
});
