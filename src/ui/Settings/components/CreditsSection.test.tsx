// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  act,
} from "@testing-library/react";
import { CreditsSection, TELEGRAM_URL, GITHUB_URL } from "./CreditsSection";

// react-i18next has no initialized instance in the node test env (i18n.ts
// touches localStorage at import time), so we stub useTranslation to return
// the defaultValue passed to t(). Components call t(key) with no default, so
// the stub resolves to the raw key ("settings.copy" -> "settings.copy");
// queries below therefore target the key strings.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, defaultValue?: string) => defaultValue ?? _key,
  }),
}));

// Never touch the real Tauri bridge in a unit test.
const openUrl = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (url: string) => openUrl(url),
}));

const copyToClipboard = vi.fn().mockResolvedValue(true);
vi.mock("../../../utils/copyToClipboard", () => ({
  copyToClipboard: (text: string) => copyToClipboard(text),
}));

const showErrorToast = vi.fn();
vi.mock("../../../utils/simpleToast", () => ({
  showErrorToast: (msg: string) => showErrorToast(msg),
}));

const captureError = vi.fn();
vi.mock("../../../utils/errorLog", () => ({
  captureError: (entry: unknown) => captureError(entry),
}));

describe("CreditsSection", () => {
  beforeEach(() => {
    openUrl.mockClear();
    copyToClipboard.mockClear();
    showErrorToast.mockClear();
    captureError.mockClear();
  });

  afterEach(() => cleanup());

  it("exposes the correct Telegram and Github URLs as constants", () => {
    expect(TELEGRAM_URL).toBe("https://t.me/nguyen_tan_an");
    expect(GITHUB_URL).toBe("https://github.com/auhsuai/drplay");
  });

  it("renders both contact names as static text with no anchors", () => {
    render(<CreditsSection />);
    expect(screen.getByText("Telegram")).toBeTruthy();
    expect(screen.getByText("Github")).toBeTruthy();
    expect(document.querySelectorAll("a").length).toBe(0);
  });

  it("clicking a contact name does NOT open the browser", () => {
    render(<CreditsSection />);
    fireEvent.click(screen.getByText("Telegram"));
    fireEvent.click(screen.getByText("Github"));
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("provides one open-link button per contact that calls openUrl with the right URL", () => {
    render(<CreditsSection />);
    const openButtons = screen.getAllByRole("button", {
      name: "settings.open_link",
    });
    expect(openButtons).toHaveLength(2);
    fireEvent.click(openButtons[0]);
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith(TELEGRAM_URL);
    fireEvent.click(openButtons[1]);
    expect(openUrl).toHaveBeenCalledTimes(2);
    expect(openUrl).toHaveBeenCalledWith(GITHUB_URL);
  });

  it("shows an error toast and logs when openUrl fails", async () => {
    openUrl.mockRejectedValueOnce(new Error("bridge down"));
    render(<CreditsSection />);
    await act(async () => {
      fireEvent.click(
        screen.getAllByRole("button", { name: "settings.open_link" })[0],
      );
    });
    expect(showErrorToast).toHaveBeenCalledWith("settings.open_link_error");
    expect(captureError).toHaveBeenCalledWith(
      expect.objectContaining({ source: "CreditsSection", level: "error" }),
    );
  });

  it("copies the display text, shows Copied!, then reverts after 2 seconds", async () => {
    vi.useFakeTimers();
    try {
      render(<CreditsSection />);
      const copyButtons = screen.getAllByTitle("settings.copy");
      expect(copyButtons).toHaveLength(2);
      fireEvent.click(copyButtons[0]);
      await act(async () => {});
      expect(copyToClipboard).toHaveBeenCalledWith("@nguyen_tan_an");
      expect(screen.getByText("settings.copied")).toBeTruthy();
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
      expect(screen.queryByText("settings.copied")).toBeNull();
      expect(screen.getByText("@nguyen_tan_an")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders each contact with static name, open-link button and copy button", () => {
    render(<CreditsSection />);
    expect(
      screen.getAllByRole("button", { name: "settings.open_link" }),
    ).toHaveLength(2);
    expect(screen.getAllByTitle("settings.copy")).toHaveLength(2);
    expect(screen.getByText("@nguyen_tan_an")).toBeTruthy();
    expect(screen.getByText("auhsuai/drplay")).toBeTruthy();
  });
});
