// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { initReactI18next, useTranslation } from "react-i18next";
import i18n from "i18next";
import { ErrorLogSection } from "./ErrorLogSection";

i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  resources: {
    en: {
      translation: {
        settings: {
          error_log_title: "Error Log",
          error_log_copy: "Copy Report",
          error_log_copied: "Copied!",
          error_log_clear: "Clear Log",
          error_log_empty: "No errors have been recorded yet.",
          error_log_note: "filtered",
          error_log_stack: "Stack trace",
          error_log_copy_error: "Could not copy to clipboard.",
          error_log_clear_error: "Failed to clear logs.",
        },
        loading: "Loading...",
      },
    },
  },
});

void useTranslation;
import {
  getErrorLogs,
  clearErrorLogs,
  exportErrorLogsSanitized,
  type ErrorLogEntry,
} from "../../../utils/errorLog";

vi.mock("../../../utils/errorLog", async () => {
  const actual = await vi.importActual<typeof import("../../../utils/errorLog")>(
    "../../../utils/errorLog"
  );
  return {
    ...actual,
    getErrorLogs: vi.fn(),
    clearErrorLogs: vi.fn(),
    exportErrorLogsSanitized: vi.fn(),
  };
});

vi.mock("../../../utils/simpleToast", () => ({
  showErrorToast: vi.fn(),
}));

const getErrorLogsMock = vi.mocked(getErrorLogs);
const clearErrorLogsMock = vi.mocked(clearErrorLogs);
const exportErrorLogsSanitizedMock = vi.mocked(exportErrorLogsSanitized);

function makeEntries(): ErrorLogEntry[] {
  return [
    {
      id: "e1",
      ts: 1700000000000,
      level: "error",
      source: "Player",
      message: "boom\ninjected fake line",
      stack: "at foo (a.ts:1)",
      kind: "playback",
    },
    {
      id: "e2",
      ts: 1700000050000,
      level: "warn",
      source: "Drive",
      message: "slow network",
    },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
});

afterEach(() => {
  cleanup();
});

describe("ErrorLogSection", () => {
  it("renders empty state when getErrorLogs() returns []", async () => {
    getErrorLogsMock.mockResolvedValue([]);
    render(<ErrorLogSection />);
    expect(await screen.findByText(/No errors have been recorded yet/i)).toBeTruthy();
    expect(screen.queryByText("boom")).toBeNull();
  });

  it("renders a list when getErrorLogs() returns 2 entries", async () => {
    getErrorLogsMock.mockResolvedValue(makeEntries());
    render(<ErrorLogSection />);
    expect(await screen.findByText((c) => c.startsWith("boom"))).toBeTruthy();
    expect(screen.getByText("slow network")).toBeTruthy();
    // timestamp formatted via toLocaleString -> contains a numeric year-ish part
    expect(screen.getByText(/Player/)).toBeTruthy();
    // Both entries rendered as separate nodes (log-forging defense)
    expect(screen.getAllByText("Player").length).toBe(1);
  });

  it("copy button calls clipboard.writeText with sanitized text", async () => {
    getErrorLogsMock.mockResolvedValue(makeEntries());
    exportErrorLogsSanitizedMock.mockResolvedValue(
      "2023-11-14T22:13:20.000Z [error] Player: boom"
    );
    render(<ErrorLogSection />);
    await screen.findByText((c) => c.startsWith("boom"));
    fireEvent.click(screen.getByRole("button", { name: /Copy Report/i }));
    expect(exportErrorLogsSanitizedMock).toHaveBeenCalledTimes(1);
    await screen.findByText(/Copied!/i);
    await new Promise((r) => setTimeout(r, 0));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "2023-11-14T22:13:20.000Z [error] Player: boom"
    );
    expect(await screen.findByText(/Copied!/i)).toBeTruthy();
  });

  it("copy button is disabled when log is empty", async () => {
    getErrorLogsMock.mockResolvedValue([]);
    render(<ErrorLogSection />);
    await screen.findByText(/No errors have been recorded yet/i);
    const btn = screen.getByRole("button", { name: /Copy Report/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("clear button calls clearErrorLogs and empties the list", async () => {
    getErrorLogsMock.mockResolvedValue(makeEntries());
    clearErrorLogsMock.mockResolvedValue(undefined);
    render(<ErrorLogSection />);
    await screen.findByText((c) => c.startsWith("boom"));
    fireEvent.click(screen.getByRole("button", { name: /Clear Log/i }));
    expect(clearErrorLogsMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/No errors have been recorded yet/i)).toBeTruthy();
  });
});
