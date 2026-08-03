// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
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

// ErrorLogSection reads logs via useLiveQuery(db.errorLogs). Mock the hook
// with a controllable return value so a test can simulate a Dexie table
// change (new entry added / table cleared) by flipping the mock + rerendering.
const { useLiveQueryMock } = vi.hoisted(() => ({ useLiveQueryMock: vi.fn() }));
vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: useLiveQueryMock,
}));

vi.mock("../../../db/db", () => ({
  db: { errorLogs: { orderBy: vi.fn() } },
}));

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
  useLiveQueryMock.mockReturnValue([]);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(() => {
  cleanup();
});

describe("ErrorLogSection", () => {
  it("renders empty state when the live query resolves to []", async () => {
    render(<ErrorLogSection />);
    expect(await screen.findByText(/No errors have been recorded yet/i)).toBeTruthy();
    expect(screen.queryByText("boom")).toBeNull();
  });

  it("renders date groups when the live query resolves to 2 entries on 2 days", async () => {
    useLiveQueryMock.mockReturnValue(makeEntries());
    render(<ErrorLogSection />);
    // Default view = grouped by day; shows date keys, not raw messages.
    expect(await screen.findByText(KEY_B)).toBeTruthy();
    expect(screen.getByText(KEY_A)).toBeTruthy();
    expect(screen.queryByText("boom day A")).toBeNull();
    // Each day row shows a count badge.
    expect(screen.getAllByText("1 errors").length).toBe(2);
  });

  it("clicking a day shows that day's entries and nothing else", async () => {
    useLiveQueryMock.mockReturnValue(makeEntries());
    render(<ErrorLogSection />);
    await screen.findByText(KEY_A);
    fireEvent.click(screen.getByText(KEY_A));

    // detail view: shows day A entry, hides day B entry, shows Back.
    expect(await screen.findByText("boom day A")).toBeTruthy();
    expect(screen.queryByText("slow network day B")).toBeNull();
    expect(screen.getByRole("button", { name: /Back/i })).toBeTruthy();
  });

  it("back button returns to the date-group view", async () => {
    useLiveQueryMock.mockReturnValue(makeEntries());
    render(<ErrorLogSection />);
    await screen.findByText(KEY_A);
    fireEvent.click(screen.getByText(KEY_A));
    await screen.findByText("boom day A");

    fireEvent.click(screen.getByRole("button", { name: /Back/i }));
    expect(await screen.findByText(KEY_B)).toBeTruthy();
    expect(screen.queryByText("boom day A")).toBeNull();
  });

  it("copy in day view calls exportErrorLogsSanitizedForDate, not the all-logs export", async () => {
    useLiveQueryMock.mockReturnValue(makeEntries());
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
    useLiveQueryMock.mockReturnValue(makeEntries());
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
    render(<ErrorLogSection />);
    await screen.findByText(/No errors have been recorded yet/i);
    // Copy/Clear buttons are only rendered in day view (selectedDate != null).
    // With empty log there are no day groups to click into, so buttons don't exist.
    expect(screen.queryByRole("button", { name: /Copy Report/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Copy Selected/i })).toBeNull();
  });

  it("clear button calls clearErrorLogs and empties the list", async () => {
    useLiveQueryMock.mockReturnValue(makeEntries());
    clearErrorLogsMock.mockResolvedValue(undefined);
    const { rerender } = render(<ErrorLogSection />);
    await screen.findByText(KEY_A);
    fireEvent.click(screen.getByText(KEY_A));
    await screen.findByText((c) => c.startsWith("boom"));
    fireEvent.click(screen.getByRole("button", { name: /Clear/i }));
    expect(clearErrorLogsMock).toHaveBeenCalledTimes(1);
    // After clearErrorLogs() the Dexie table changed; the live query re-runs
    // with [] — simulate that subscription push like the real hook would.
    useLiveQueryMock.mockReturnValue([]);
    act(() => {
      rerender(<ErrorLogSection />);
    });
    expect(await screen.findByText(/No errors have been recorded yet/i)).toBeTruthy();
  });

  it("renders a newly captured log without remounting (live table update)", async () => {
    useLiveQueryMock.mockReturnValue([]);
    const { rerender } = render(<ErrorLogSection />);
    expect(await screen.findByText(/No errors have been recorded yet/i)).toBeTruthy();

    // REGRESSION (BUG 1): captureError() wrote a new entry into db.errorLogs.
    // The component must show it WITHOUT being remounted — the live query
    // re-runs and pushes the new result.
    useLiveQueryMock.mockReturnValue(makeEntries());
    act(() => {
      rerender(<ErrorLogSection />);
    });

    expect(await screen.findByText(KEY_A)).toBeTruthy();
    expect(screen.queryByText(/No errors have been recorded yet/i)).toBeNull();
  });

  it("live table update is reflected while a day-detail view is open", async () => {
    useLiveQueryMock.mockReturnValue(makeEntries());
    const { rerender } = render(<ErrorLogSection />);
    await screen.findByText(KEY_A);
    fireEvent.click(screen.getByText(KEY_A));
    await screen.findByText("boom day A");

    // New entry lands on the SAME day while its detail view is open.
    const withNewEntry: ErrorLogEntry[] = [
      ...makeEntries(),
      {
        id: "a2",
        ts: DAY_A + 60_000,
        level: "error",
        source: "Player",
        message: "fresh crash on day A",
      },
    ];
    useLiveQueryMock.mockReturnValue(withNewEntry);
    act(() => {
      rerender(<ErrorLogSection />);
    });

    expect(await screen.findByText("fresh crash on day A")).toBeTruthy();
    expect(screen.getByText("boom day A")).toBeTruthy();
  });
});
