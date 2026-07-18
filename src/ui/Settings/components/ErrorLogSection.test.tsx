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
          error_log_copy_selected: "Copy Selected",
          error_log_copied: "Copied!",
          error_log_clear: "Clear",
          error_log_empty: "No errors have been recorded yet.",
          error_log_note: "filtered",
          error_log_stack: "Stack trace",
          error_log_copy_error: "Could not copy to clipboard.",
          error_log_clear_error: "Failed to clear logs.",
          error_log_by_date: "Errors by day",
          error_log_back: "Back",
          error_log_count: "{{count}} errors",
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
  exportErrorLogsSanitizedForDate,
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
    exportErrorLogsSanitizedForDate: vi.fn(),
  };
});

vi.mock("../../../utils/simpleToast", () => ({
  showErrorToast: vi.fn(),
}));

const clipboardWriteTextMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: clipboardWriteTextMock,
}));

const getErrorLogsMock = vi.mocked(getErrorLogs);
const clearErrorLogsMock = vi.mocked(clearErrorLogs);
const exportErrorLogsSanitizedMock = vi.mocked(exportErrorLogsSanitized);
const exportErrorLogsSanitizedForDateMock = vi.mocked(
  exportErrorLogsSanitizedForDate
);

// Two distinct local dates so grouping has 2 buckets.
const DAY_A = new Date(2023, 10, 1, 9, 0, 0).getTime(); // Nov 1
const DAY_B = new Date(2023, 10, 5, 9, 0, 0).getTime(); // Nov 5
const KEY_A = new Date(DAY_A).toLocaleDateString();
const KEY_B = new Date(DAY_B).toLocaleDateString();

function makeEntries(): ErrorLogEntry[] {
  return [
    {
      id: "a1",
      ts: DAY_A,
      level: "error",
      source: "Player",
      message: "boom day A",
      stack: "at foo (a.ts:1)",
      kind: "playback",
    },
    {
      id: "b1",
      ts: DAY_B,
      level: "warn",
      source: "Drive",
      message: "slow network day B",
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

  it("renders date groups when getErrorLogs() returns 2 entries on 2 days", async () => {
    getErrorLogsMock.mockResolvedValue(makeEntries());
    render(<ErrorLogSection />);
    // Default view = grouped by day; shows date keys, not raw messages.
    expect(await screen.findByText(KEY_B)).toBeTruthy();
    expect(screen.getByText(KEY_A)).toBeTruthy();
    expect(screen.queryByText("boom day A")).toBeNull();
    // Each day row shows a count badge.
    expect(screen.getAllByText("1 errors").length).toBe(2);
  });

  it("clicking a day shows that day's entries and nothing else", async () => {
    getErrorLogsMock.mockResolvedValue(makeEntries());
    render(<ErrorLogSection />);
    await screen.findByText(KEY_A);
    fireEvent.click(screen.getByText(KEY_A));

    // detail view: shows day A entry, hides day B entry, shows Back.
    expect(await screen.findByText("boom day A")).toBeTruthy();
    expect(screen.queryByText("slow network day B")).toBeNull();
    expect(screen.getByRole("button", { name: /Back/i })).toBeTruthy();
  });

  it("back button returns to the date-group view", async () => {
    getErrorLogsMock.mockResolvedValue(makeEntries());
    render(<ErrorLogSection />);
    await screen.findByText(KEY_A);
    fireEvent.click(screen.getByText(KEY_A));
    await screen.findByText("boom day A");

    fireEvent.click(screen.getByRole("button", { name: /Back/i }));
    expect(await screen.findByText(KEY_B)).toBeTruthy();
    expect(screen.queryByText("boom day A")).toBeNull();
  });

  it("copy in day view calls exportErrorLogsSanitizedForDate, not the all-logs export", async () => {
    getErrorLogsMock.mockResolvedValue(makeEntries());
    exportErrorLogsSanitizedForDateMock.mockResolvedValue("day report text");
    render(<ErrorLogSection />);
    await screen.findByText(KEY_A);
    fireEvent.click(screen.getByText(KEY_A));
    await screen.findByText("boom day A");

    fireEvent.click(screen.getByRole("button", { name: /Copy Report/i }));
    expect(exportErrorLogsSanitizedForDateMock).toHaveBeenCalledTimes(1);
    expect(exportErrorLogsSanitizedForDateMock).toHaveBeenCalledWith(KEY_A);
    expect(exportErrorLogsSanitizedMock).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0));
    expect(clipboardWriteTextMock).toHaveBeenCalledWith("day report text");
  });

  it("copy button calls clipboard.writeText with sanitized text", async () => {
    getErrorLogsMock.mockResolvedValue(makeEntries());
    exportErrorLogsSanitizedForDateMock.mockResolvedValue(
      "2023-11-14T22:13:20.000Z [error] Player: boom"
    );
    render(<ErrorLogSection />);
    await screen.findByText(KEY_A);
    fireEvent.click(screen.getByText(KEY_A));
    await screen.findByText((c) => c.startsWith("boom"));
    fireEvent.click(screen.getByRole("button", { name: /Copy Report/i }));
    expect(exportErrorLogsSanitizedForDateMock).toHaveBeenCalledTimes(1);
    await screen.findByText(/Copied!/i);
    await new Promise((r) => setTimeout(r, 0));
    expect(clipboardWriteTextMock).toHaveBeenCalledWith(
      "2023-11-14T22:13:20.000Z [error] Player: boom"
    );
    expect(await screen.findByText(/Copied!/i)).toBeTruthy();
  });

  it("copy button is disabled when log is empty and in day view", async () => {
    getErrorLogsMock.mockResolvedValue([]);
    render(<ErrorLogSection />);
    await screen.findByText(/No errors have been recorded yet/i);
    // Copy/Clear buttons are only rendered in day view (selectedDate != null).
    // With empty log there are no day groups to click into, so buttons don't exist.
    expect(screen.queryByRole("button", { name: /Copy Report/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Copy Selected/i })).toBeNull();
  });

  it("clear button calls clearErrorLogs and empties the list", async () => {
    getErrorLogsMock.mockResolvedValue(makeEntries());
    clearErrorLogsMock.mockResolvedValue(undefined);
    render(<ErrorLogSection />);
    await screen.findByText(KEY_A);
    fireEvent.click(screen.getByText(KEY_A));
    await screen.findByText((c) => c.startsWith("boom"));
    fireEvent.click(screen.getByRole("button", { name: /Clear/i }));
    expect(clearErrorLogsMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/No errors have been recorded yet/i)).toBeTruthy();
  });
});
