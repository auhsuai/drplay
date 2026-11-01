// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: unknown) => Promise<void>>(() =>
    Promise.resolve(),
  ),
  isTauri: vi.fn(() => true),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
  isTauri: tauriMocks.isTauri,
}));

const errorLogMock = vi.hoisted(() => ({
  captureError: vi.fn<
    (input: {
      level?: string;
      source: string;
      message: string;
    }) => Promise<void>
  >(() => Promise.resolve()),
}));

vi.mock("./utils/errorLog", () => ({
  captureError: errorLogMock.captureError,
}));

import i18n from "./i18n";

const COMMAND = "set_tray_labels";

// Snapshot of what the module-scope init() emitted. i18next emits
// 'languageChanged' synchronously inside init() (bundled resources), so this is
// the "before first paint" push that main.tsx relies on — it happened during the
// import above, before any test body ran.
const bootCalls = [...tauriMocks.invoke.mock.calls];

function trayCalls(): Array<[string, unknown?]> {
  return tauriMocks.invoke.mock.calls.filter(
    ([command]) => command === COMMAND,
  );
}

describe("i18n tray label sync", () => {
  beforeEach(() => {
    tauriMocks.isTauri.mockReturnValue(true);
    tauriMocks.invoke.mockClear();
    errorLogMock.captureError.mockClear();
    localStorage.clear();
  });

  // Restore English so the shared instance never leaks 'vi' into a later
  // assertion (the file owns one i18n instance for the whole module graph).
  afterEach(async () => {
    tauriMocks.isTauri.mockReturnValue(true);
    await i18n.changeLanguage("en");
  });

  it("pushes the English labels during module init (synchronous languageChanged)", () => {
    expect(bootCalls).toContainEqual([
      COMMAND,
      { show: "Show DrPlay", quit: "Quit" },
    ]);
  });

  it("pushes the translated labels after changeLanguage('vi')", async () => {
    await i18n.changeLanguage("vi");

    expect(trayCalls()).toContainEqual([
      COMMAND,
      { show: "Hiện DrPlay", quit: "Thoát" },
    ]);
  });

  it("no-ops outside Tauri so jsdom/browser boots never call invoke", async () => {
    tauriMocks.isTauri.mockReturnValue(false);

    await i18n.changeLanguage("vi");

    expect(tauriMocks.invoke).not.toHaveBeenCalled();
  });

  it("logs a warn and never throws when the command fails", async () => {
    tauriMocks.invoke.mockRejectedValueOnce(new Error("ipc exploded"));

    await expect(i18n.changeLanguage("vi")).resolves.toBeDefined();

    await vi.waitFor(() => {
      expect(errorLogMock.captureError).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "warn",
          source: "i18n",
          message: expect.stringContaining(
            "tray-label-sync-failed: ipc exploded",
          ) as unknown as string,
        }),
      );
    });
  });
});
