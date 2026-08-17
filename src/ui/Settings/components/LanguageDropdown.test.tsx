// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageDropdown } from "./LanguageDropdown";
import { handleGlobalBack } from "../../../hooks/useHardwareBack";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: {
      language: "en",
      changeLanguage: vi.fn().mockResolvedValue(undefined),
    },
  }),
}));

// localStorage write can throw in jsdom when storage is full or blocked —
// the real component already swallows; spy so we can confirm a write was
// attempted without crashing the test.
const localStorageSetItem = vi.fn();
vi.mock("../../../utils/storageKeys", () => ({
  LANGUAGE_KEY: "drplay_language",
}));

Object.defineProperty(window, "localStorage", {
  value: {
    setItem: localStorageSetItem,
    getItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
  },
  configurable: true,
});

describe("LanguageDropdown hardware-back closes the menu (batch fix 2026-08-17)", () => {
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
    return screen.getByRole("button", { name: /settings\.english/ });
  }

  it("closes the menu when open (handleGlobalBack true, then false)", () => {
    render(<LanguageDropdown />);
    fireEvent.click(trigger());
    // Two "settings.english" buttons now visible: the trigger + the option.
    expect(
      screen.getAllByRole("button", { name: /settings\.english/ }),
    ).toHaveLength(2);

    expect(pressBack()).toBe(true);
    // Back to a single button (just the trigger).
    expect(
      screen.getAllByRole("button", { name: /settings\.english/ }),
    ).toHaveLength(1);

    expect(pressBack()).toBe(false);
  });

  it("does not register the back handler while the menu is closed (no fall-through)", () => {
    render(<LanguageDropdown />);
    expect(pressBack()).toBe(false);
  });

  it("removes the back handler on unmount (no leak across tests)", () => {
    const { unmount } = render(<LanguageDropdown />);
    fireEvent.click(trigger());
    unmount();

    expect(pressBack()).toBe(false);
  });
});
