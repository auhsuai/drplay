// @vitest-environment jsdom
/**
 * FallbackEngineSection — the OPTIONAL mpv.exe fallback, one inline Settings
 * row.
 *
 * The wire contract under test (frozen by Slice 3):
 *   get_mpv_fallback_status -> FallbackStatusDto  (camelCase, optional fields
 *                                                 OMITTED when absent)
 *   install_mpv_fallback    -> FallbackStatusDto  (re-queried and therefore
 *                                                 authoritative for success)
 *   "mpv-fallback-progress" -> {stage, downloaded, total, percent}
 *   rejection               -> "<code>: <text>"
 *
 * Two invariants get their own tests because they are easy to regress:
 *   * `stage: "installed"` says the FILE is on disk, never that it is in use —
 *     only `engine: "legacy"` means in use.
 *   * A failed re-install must keep the previously installed facts visible.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
  act,
} from "@testing-library/react";
import { FallbackEngineSection } from "./FallbackEngineSection";
import { SettingsTab } from "../SettingsTab";
import type { ThemeType } from "../../../hooks/useTheme";
import en from "../../../locales/en/translation.json";

// react-i18next has no initialized instance in the node test env (i18n.ts
// touches localStorage at import time), so stub useTranslation to resolve
// against the real en resources (same block as SettingsTab.test.tsx:21-52).
vi.mock("react-i18next", () => {
  const resolveKey = (key: string): string | undefined => {
    let acc: unknown = en;
    for (const part of key.split(".")) {
      if (typeof acc === "object" && acc !== null) {
        acc = (acc as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }
    return typeof acc === "string" ? acc : undefined;
  };
  return {
    useTranslation: () => ({
      // i18next's t(key, options) shape: the second argument carries the
      // interpolation vars ({{version}}). A string second arg is the
      // defaultValue fallback.
      t: (key: string, options?: Record<string, string | number> | string) => {
        const resolved =
          resolveKey(key) ?? (typeof options === "string" ? options : key);
        if (typeof options === "object") {
          return resolved.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
            String(options[name] ?? `{{${name}}}`),
          );
        }
        return resolved;
      },
    }),
  };
});

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

// Event listeners: `listen` hands back an UnlistenFn and the test pushes
// payloads through the captured handler, exactly like the real event bus. Two
// channels exist now (progress + settled-changed), so handlers are keyed by
// event name — a single flat list would let a progress frame reach the
// changed-event listener and prove nothing.
const eventMocks = vi.hoisted(() => ({
  listen: vi.fn(),
  // Real `listen` hands the handler a Tauri Event: { event, id, payload }.
  handlers: [] as Array<{
    event: string;
    handler: (event: { payload: unknown }) => void;
  }>,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: eventMocks.listen }));

const toastMocks = vi.hoisted(() => ({
  showErrorToast: vi.fn(),
  showSuccessToast: vi.fn(),
}));
vi.mock("../../../utils/simpleToast", () => ({
  showErrorToast: toastMocks.showErrorToast,
  showSuccessToast: toastMocks.showSuccessToast,
}));

const errorMocks = vi.hoisted(() => ({ captureError: vi.fn() }));
vi.mock("../../../utils/errorLog", () => ({
  captureError: errorMocks.captureError,
}));

// SettingsTab pulls these in; stub the heavy/irrelevant ones so the
// integration test mounts the real FallbackEngineSection only.
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../../../utils/downloadPath", () => ({
  getEffectiveDownloadPath: vi.fn().mockResolvedValue(""),
  setCustomDownloadPath: vi.fn(),
}));
vi.mock("../../../utils/cache", () => ({
  clearAppCache: vi.fn(),
  getCacheSizes: vi.fn().mockResolvedValue([]),
  getFallbackEngineSize: vi.fn().mockResolvedValue(null),
  removeFallbackEngine: vi.fn(),
  FALLBACK_ENGINE_ID: "fallback_engine",
  CACHE_CATEGORY_LABELS: {
    metadata: "Metadata cache",
    files: "File listing cache",
    covers: "Covers & thumbnails",
    prefetch: "Prefetched data",
  },
}));
vi.mock("../components/LanguageDropdown", () => ({
  LanguageDropdown: () => null,
}));
vi.mock("../components/ThemeDropdown", () => ({ ThemeDropdown: () => null }));
vi.mock("../components/CreditsSection", () => ({ CreditsSection: () => null }));
vi.mock("../components/ErrorLogSection", () => ({
  ErrorLogSection: () => null,
}));

const STATUS_COMMAND = "get_mpv_fallback_status";
const INSTALL_COMMAND = "install_mpv_fallback";
// Mirrors of the exported constants (importing them would be circular for the
// mock assertions, and a rename must fail these tests loudly).
const PROGRESS_EVENT = "mpv-fallback-progress";
const CHANGED_EVENT = "mpv-fallback-changed";

const PINNED = "2026-10-18-fffe7a23a8";

function notInstalled() {
  return { stage: "notInstalled", engine: "libmpv", pinnedVersion: PINNED };
}

function installed(overrides: Record<string, unknown> = {}) {
  return {
    stage: "installed",
    version: "0.40.0.0",
    path: "C:\\data\\engines\\mpv\\v\\mpv.exe",
    size: 121_946_112,
    engine: "legacy",
    sidecarPath: "C:\\data\\engines\\mpv\\v\\mpv.exe",
    pinnedVersion: PINNED,
    ...overrides,
  };
}

const baseProps = {
  theme: "dark" as ThemeType,
  setTheme: vi.fn(),
  minimizeToTray: false,
  setMinimizeToTray: vi.fn(),
  setShowFolderSelection: vi.fn(),
  setShowTrashScreen: vi.fn(),
  configSync: null,
  onRetryConfigSync: vi.fn<() => Promise<void>>(),
};

/**
 * The backend's rejection contract IS a string ("<code>: <text>"), not an
 * Error. This helper is the single place the test deliberately rejects with a
 * non-Error value, so the rule stays enabled everywhere else.
 */
function rejectWire(value: string): Promise<never> {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
  return Promise.reject(value);
}

/** Routes invoke by command name so both commands can be steered separately. */
function routeInvoke(handlers: {
  status?: () => Promise<unknown>;
  install?: () => Promise<unknown>;
}) {
  invokeMock.mockImplementation((command: string) => {
    if (command === STATUS_COMMAND) {
      return handlers.status !== undefined
        ? handlers.status()
        : Promise.resolve(notInstalled());
    }
    if (command === INSTALL_COMMAND) {
      return handlers.install !== undefined
        ? handlers.install()
        : Promise.resolve(installed());
    }
    return Promise.resolve(undefined);
  });
}

function installCalls(): number {
  return invokeMock.mock.calls.filter(
    (call) => (call as unknown as [string])[0] === INSTALL_COMMAND,
  ).length;
}

function statusCalls(): number {
  return invokeMock.mock.calls.filter(
    (call) => (call as unknown as [string])[0] === STATUS_COMMAND,
  ).length;
}

/** Push a payload into the listeners registered for `eventName` only. */
async function pushEvent(eventName: string, payload: unknown): Promise<void> {
  await act(async () => {
    for (const entry of [...eventMocks.handlers]) {
      if (entry.event === eventName) entry.handler({ payload });
    }
    await Promise.resolve();
  });
}

async function pushProgress(payload: unknown): Promise<void> {
  await pushEvent(PROGRESS_EVENT, payload);
}

async function pushChanged(payload: unknown): Promise<void> {
  await pushEvent(CHANGED_EVENT, payload);
}

beforeEach(() => {
  invokeMock.mockReset();
  toastMocks.showErrorToast.mockReset();
  toastMocks.showSuccessToast.mockReset();
  errorMocks.captureError.mockReset();
  eventMocks.listen.mockReset();
  eventMocks.handlers.length = 0;
  eventMocks.listen.mockImplementation(
    (name: string, handler: (event: { payload: unknown }) => void) => {
      eventMocks.handlers.push({ event: name, handler });
      return Promise.resolve(vi.fn());
    },
  );
  routeInvoke({});
});

afterEach(() => {
  cleanup();
});

describe("FallbackEngineSection — mount and copy", () => {
  // (1) Renders within the existing Settings page.
  it("renders inside SettingsTab with the localized section heading", async () => {
    render(<SettingsTab {...baseProps} />);

    const section = await screen.findByTestId("fallback-engine-section");
    expect(section).toBeTruthy();
    expect(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      section.querySelector("h2")!.textContent,
    ).toBe("Playback Components");
  });

  // (2) All user-facing strings resolve from localization (no raw keys).
  it("shows real English copy and never a raw i18n key", async () => {
    render(<FallbackEngineSection />);

    expect(await screen.findByText("mpv.exe fallback engine")).toBeTruthy();
    expect(screen.getByText("Not installed · optional")).toBeTruthy();
    // The pinned build is named BEFORE the download, from the status DTO.
    expect(screen.getByText("Not installed · optional")).toBeTruthy();
    expect(screen.queryByText(/settings\.playback_components\./)).toBeNull();
    expect(screen.getByText("Download")).toBeTruthy();
  });
});

describe("FallbackEngineSection — checking state", () => {
  // (3) `checking` while the initial promise is in flight; "not installed"
  // must NOT flash first.
  it("shows checking before the status promise resolves and never flashes not-installed", async () => {
    let resolveStatus: (value: unknown) => void = () => {};
    routeInvoke({
      status: () =>
        new Promise<unknown>((resolve) => {
          resolveStatus = resolve;
        }),
    });

    render(<FallbackEngineSection />);

    expect(screen.getByTestId("fallback-engine-checking")).toBeTruthy();
    expect(
      screen.getByText(/Checking whether the fallback engine/),
    ).toBeTruthy();
    expect(screen.queryByText(/Not installed · optional/)).toBeNull();

    await act(async () => {
      resolveStatus(notInstalled());
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByTestId("fallback-engine-checking")).toBeNull();
    });
    expect(screen.getByText("Not installed · optional")).toBeTruthy();
  });
});

describe("FallbackEngineSection — not installed", () => {
  // (4) notInstalled -> an enabled Download button.
  it("offers Download when the engine is not installed", async () => {
    render(<FallbackEngineSection />);

    const button = await screen.findByTestId<HTMLButtonElement>(
      "fallback-engine-action",
    );
    expect(button.textContent).toContain("Download");
    expect(button.disabled).toBe(false);
    expect(screen.getByText("Not installed · optional")).toBeTruthy();
  });
});

describe("FallbackEngineSection — progress", () => {
  // (5a) Determinate: the bar carries the real percentage.
  it("renders a determinate progressbar with the percentage only (no byte counters)", async () => {
    routeInvoke({
      install: () => new Promise<unknown>(() => {}),
    });
    render(<FallbackEngineSection />);
    fireEvent.click(await screen.findByTestId("fallback-engine-action"));

    await pushProgress({
      stage: "downloading",
      downloaded: 12,
      total: 48,
      percent: 25,
    });

    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("25");
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("100");
    // No numeric readout at all: the bar itself is the progress signal.
    expect(screen.queryByTestId("fallback-engine-progress-text")).toBeNull();
    expect(screen.queryByTestId("fallback-engine-progress-bytes")).toBeNull();
    // The resting "Not installed · optional · …" line is replaced by the
    // progress stage while the install runs: two contradictory states must
    // never be on screen together.
    expect(screen.queryByText(/Not installed · optional/)).toBeNull();
    expect(screen.getByText(/Downloading the fallback engine/)).toBeTruthy();
  });

  // (5b) Indeterminate: percent null -> no fabricated number.
  it("renders an indeterminate bar with no percentage when percent is null", async () => {
    routeInvoke({
      install: () => new Promise<unknown>(() => {}),
    });
    render(<FallbackEngineSection />);
    fireEvent.click(await screen.findByTestId("fallback-engine-action"));

    await pushProgress({
      stage: "downloading",
      downloaded: 42,
      total: null,
      percent: null,
    });

    const bar = screen.getByRole("progressbar");
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    expect(screen.queryByTestId("fallback-engine-progress-text")).toBeNull();
    expect(screen.queryByTestId("fallback-engine-progress-bytes")).toBeNull();
    // Still labelled for assistive tech.
    expect(bar.getAttribute("aria-label")).toBe(
      "Fallback engine installation progress",
    );
  });

  // (6) The three non-downloading stages each get their own label.
  it("updates the stage label for verifying, extracting and publishing", async () => {
    routeInvoke({
      install: () => new Promise<unknown>(() => {}),
    });
    render(<FallbackEngineSection />);
    fireEvent.click(await screen.findByTestId("fallback-engine-action"));

    await pushProgress({
      stage: "verifying",
      downloaded: null,
      total: null,
      percent: null,
    });
    expect(screen.getByText("Verifying the downloaded file…")).toBeTruthy();

    await pushProgress({
      stage: "extracting",
      downloaded: null,
      total: null,
      percent: null,
    });
    expect(screen.getByText("Extracting the fallback engine…")).toBeTruthy();

    await pushProgress({
      stage: "publishing",
      downloaded: null,
      total: null,
      percent: null,
    });
    expect(screen.getByText("Finishing the installation…")).toBeTruthy();
  });
});

describe("FallbackEngineSection — installed", () => {
  // (7) Success -> installed facts from the command's own return value,
  // with a second status query on mount (initial + reinstall).
  it("shows the installed version and size, and queries status again on reinstall", async () => {
    routeInvoke({
      status: () => Promise.resolve(notInstalled()),
      install: () => Promise.resolve(installed({ engine: "libmpv" })),
    });
    render(<FallbackEngineSection />);

    fireEvent.click(await screen.findByTestId("fallback-engine-action"));

    await screen.findByTestId("fallback-engine-installed");

    expect(toastMocks.showSuccessToast).toHaveBeenCalledTimes(1);

    // Exactly two invokes: the initial read, then the install (whose own
    // return value is the re-queried status — no client-side second poll).
    expect(statusCalls()).toBe(1);
    expect(installCalls()).toBe(1);
    expect(invokeMock).toHaveBeenCalledTimes(2);

    // Reinstall re-invokes install (no new status poll of its own).
    fireEvent.click(screen.getByTestId("fallback-engine-action"));
    await waitFor(() => {
      expect(installCalls()).toBe(2);
    });
  });

  it("says the fallback IS in use when engine is legacy", async () => {
    routeInvoke({ status: () => Promise.resolve(installed()) });
    render(<FallbackEngineSection />);

    expect(await screen.findByTestId("fallback-engine-installed")).toBeTruthy();
  });

  it("explains an unavailable engine with its backend reason", async () => {
    routeInvoke({
      status: () =>
        Promise.resolve({
          stage: "notInstalled",
          engine: "unavailable",
          unavailableReason: "libmpvFailedNoSidecar",
          pinnedVersion: PINNED,
        }),
    });
    render(<FallbackEngineSection />);

    // The row explains WHY with the backend-mapped reason line. The generic
    // "No playback engine available" line is the fallback for a missing
    // reason, so it must NOT also render (one line, not two).
    expect(
      await screen.findByText(/libmpv could not start and no fallback engine/),
    ).toBeTruthy();
    expect(screen.queryByText("No playback engine available")).toBeNull();
  });
});

describe("FallbackEngineSection — re-entrancy", () => {
  // (8) Two clicks in the same tick must reach Rust once.
  it("ignores a second click while an install is already in flight", async () => {
    routeInvoke({ install: () => new Promise<unknown>(() => {}) });
    render(<FallbackEngineSection />);

    const button = await screen.findByTestId<HTMLButtonElement>(
      "fallback-engine-action",
    );
    fireEvent.click(button);
    fireEvent.click(button);
    await act(async () => {
      await Promise.resolve();
    });

    expect(installCalls()).toBe(1);
  });

  // (11) The button is disabled for the whole in-flight install.
  it("disables the action button while installing and re-enables it after", async () => {
    let resolveInstall: (value: unknown) => void = () => {};
    routeInvoke({
      install: () =>
        new Promise<unknown>((resolve) => {
          resolveInstall = resolve;
        }),
    });
    render(<FallbackEngineSection />);

    const button = await screen.findByTestId<HTMLButtonElement>(
      "fallback-engine-action",
    );
    expect(button.disabled).toBe(false);
    fireEvent.click(button);

    await waitFor(() => {
      expect(
        screen.getByTestId<HTMLButtonElement>("fallback-engine-action")
          .disabled,
      ).toBe(true);
    });

    await act(async () => {
      resolveInstall(installed());
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(
        screen.getByTestId<HTMLButtonElement>("fallback-engine-action")
          .disabled,
      ).toBe(false);
    });
  });
});

describe("FallbackEngineSection — errors", () => {
  // (9) Error is persistent and localized per code; the row action retries.
  it("shows a persistent localized error and retries through the row action", async () => {
    routeInvoke({
      install: () =>
        rejectWire("checksum_mismatch: the archive failed its integrity check"),
    });
    render(<FallbackEngineSection />);
    fireEvent.click(await screen.findByTestId("fallback-engine-action"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "The downloaded file failed its integrity check",
    );
    // Raw backend text is not rendered: the code maps to localized copy and
    // the full detail goes to the error log instead.
    expect(alert.textContent).not.toContain("checksum_mismatch:");
    expect(toastMocks.showErrorToast).toHaveBeenCalledWith(
      "Couldn't install the fallback engine. Try again.",
      { duration: 4000 },
    );
    // Stays on screen (no auto-dismiss, no timer).
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("alert")).toBeTruthy();

    // The row action is the retry affordance: a real second install.
    routeInvoke({ install: () => Promise.resolve(installed()) });
    fireEvent.click(screen.getByTestId("fallback-engine-action"));
    await waitFor(() => {
      expect(installCalls()).toBe(2);
    });
    await waitFor(() => {
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });

  it("falls back to a generic message for an unknown code", async () => {
    routeInvoke({
      install: () => rejectWire("brand_new_code: something odd"),
    });
    render(<FallbackEngineSection />);
    fireEvent.click(await screen.findByTestId("fallback-engine-action"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "The fallback engine couldn't be installed.",
    );
  });

  // (10) A failed UPDATE keeps the previously installed facts visible.
  it("keeps the installed facts visible when a later install fails", async () => {
    routeInvoke({
      status: () => Promise.resolve(installed({ engine: "legacy" })),
      install: () => rejectWire("network: connection reset"),
    });
    render(<FallbackEngineSection />);

    // Installed facts are on screen first (the engine line is the visible
    // proof that a validated install is being reported).
    expect(await screen.findByTestId("fallback-engine-installed")).toBeTruthy();

    fireEvent.click(screen.getByTestId("fallback-engine-action"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't reach the download server");
    // The facts did NOT get replaced by an error state.
    expect(screen.getByTestId("fallback-engine-installed")).toBeTruthy();
  });

  it("reports a failed initial status read inline without claiming a stage", async () => {
    routeInvoke({
      status: () => rejectWire("path_unavailable: no local data dir"),
    });
    render(<FallbackEngineSection />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "The application data folder is unavailable",
    );
    expect(screen.queryByText(/Not installed · optional/)).toBeNull();
    // The row action re-reads the status instead of installing blindly.
    routeInvoke({ status: () => Promise.resolve(notInstalled()) });
    fireEvent.click(screen.getByTestId("fallback-engine-action"));
    await waitFor(() => {
      expect(screen.getByText("Not installed · optional")).toBeTruthy();
    });
    expect(installCalls()).toBe(0);
  });
});

describe("FallbackEngineSection — listener lifecycle", () => {
  // (12) Unmount runs BOTH captured UnlistenFns (progress + changed).
  it("removes every event listener on unmount", async () => {
    const unlisten = vi.fn();
    eventMocks.listen.mockImplementation(
      (name: string, handler: (event: { payload: unknown }) => void) => {
        eventMocks.handlers.push({ event: name, handler });
        return Promise.resolve(unlisten);
      },
    );

    const { unmount } = render(<FallbackEngineSection />);
    // Two channels now: progress and the settled-change announcement.
    await waitFor(() => {
      expect(eventMocks.listen).toHaveBeenCalledTimes(2);
    });
    await act(async () => {
      await Promise.resolve();
    });

    unmount();
    expect(unlisten).toHaveBeenCalledTimes(2);
  });

  it("subscribes to the progress and changed events by name", async () => {
    render(<FallbackEngineSection />);
    await screen.findByTestId("fallback-engine-action");
    await act(async () => {
      await Promise.resolve();
    });

    const names = eventMocks.listen.mock.calls.map(
      (call) => (call as unknown as [string])[0],
    );
    expect(names).toContain(PROGRESS_EVENT);
    expect(names).toContain(CHANGED_EVENT);
    // No channel is registered twice (StrictMode-safe in dev, one each here).
    expect(new Set(names).size).toBe(names.length);
  });

  it("ignores progress events that arrive while no install is running", async () => {
    render(<FallbackEngineSection />);
    await screen.findByTestId("fallback-engine-action");

    await pushProgress({
      stage: "downloading",
      downloaded: 1,
      total: 2,
      percent: 50,
    });

    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});

describe("FallbackEngineSection — settled-change event (removal elsewhere)", () => {
  // BUG 2: the cache dialog removes this engine. Without an announcement the
  // row keeps offering "Reinstall" for a file that no longer exists.
  it("switches to Download when a notInstalled status is announced", async () => {
    routeInvoke({ status: () => Promise.resolve(installed()) });
    render(<FallbackEngineSection />);

    // Settled on the installed facts first.
    await waitFor(() => {
      expect(
        screen.getByTestId("fallback-engine-action").textContent,
      ).toContain("Reinstall");
    });
    expect(screen.getByTestId("fallback-engine-installed")).toBeTruthy();

    await pushChanged(notInstalled());

    await waitFor(() => {
      expect(
        screen.getByTestId("fallback-engine-action").textContent,
      ).toContain("Download");
    });
    // The installed line is gone, replaced by the honest not-installed copy.

    expect(screen.getByText("Not installed · optional")).toBeTruthy();
    // Applying the payload must not need a re-read.
    expect(statusCalls()).toBe(1);
  });

  it("re-reads the status when the announced payload is unusable", async () => {
    routeInvoke({ status: () => Promise.resolve(installed()) });
    render(<FallbackEngineSection />);
    await waitFor(() => {
      expect(
        screen.getByTestId("fallback-engine-action").textContent,
      ).toContain("Reinstall");
    });

    // Drifted payload: a re-read is the only safe answer.
    routeInvoke({ status: () => Promise.resolve(notInstalled()) });
    await pushChanged({ nonsense: true });

    await waitFor(() => {
      expect(statusCalls()).toBe(2);
    });
    await waitFor(() => {
      expect(
        screen.getByTestId("fallback-engine-action").textContent,
      ).toContain("Download");
    });
  });

  it("ignores an announcement while an install is in flight", async () => {
    routeInvoke({
      status: () => Promise.resolve(installed()),
      install: () => new Promise<unknown>(() => {}),
    });
    render(<FallbackEngineSection />);
    fireEvent.click(await screen.findByTestId("fallback-engine-action"));

    // A stale announcement from the pre-install disk.
    await pushChanged(notInstalled());

    // The install owns the row: the announcement is ignored, so the row keeps
    // the installed facts and never shows the not-installed copy underneath.
    expect(screen.queryByText(/Not installed · optional/)).toBeNull();
    expect(screen.getByTestId("fallback-engine-installed")).toBeTruthy();
    expect(screen.getByTestId("fallback-engine-action").textContent).toContain(
      "Reinstall",
    );
  });

  it("does not lower the row to not-installed on a stale status read after settling", async () => {
    // BUG 4 (root cause): the mount read is still in flight when the install
    // finishes. Its reply describes the PRE-install disk; applying it late used
    // to flip "installed" back to "Download".
    let resolveInitialStatus!: (value: unknown) => void;
    invokeMock.mockImplementation((command: string) => {
      if (command === STATUS_COMMAND) {
        return new Promise((resolve) => {
          resolveInitialStatus = resolve;
        });
      }
      return Promise.resolve(installed());
    });

    render(<FallbackEngineSection />);
    // Still checking, and the action is available.
    expect(screen.getByTestId("fallback-engine-checking")).toBeTruthy();
    fireEvent.click(screen.getByTestId("fallback-engine-action"));

    await waitFor(() => {
      expect(
        screen.getByTestId("fallback-engine-action").textContent,
      ).toContain("Reinstall");
    });

    // The pre-install reply now lands.
    await act(async () => {
      resolveInitialStatus(notInstalled());
      await Promise.resolve();
    });

    // The settled install must survive the stale read.
    expect(screen.getByTestId("fallback-engine-action").textContent).toContain(
      "Reinstall",
    );
    expect(screen.getByTestId("fallback-engine-installed")).toBeTruthy();
    expect(screen.queryByText(/Not installed · optional/)).toBeNull();
  });
});

describe("FallbackEngineSection — progress cannot unseat a settled status", () => {
  // BUG 4 (symptom): a late progress frame arriving after the command resolved
  // used to re-enter the "Downloading…" branch (progress outranks status) and
  // hide the freshly installed facts.
  it("keeps the installed state when a downloading frame arrives after the install resolves", async () => {
    routeInvoke({ install: () => Promise.resolve(installed()) });
    render(<FallbackEngineSection />);
    fireEvent.click(await screen.findByTestId("fallback-engine-action"));

    await waitFor(() => {
      expect(
        screen.getByTestId("fallback-engine-action").textContent,
      ).toContain("Reinstall");
    });

    // The late frame.
    await pushProgress({
      stage: "downloading",
      downloaded: 99,
      total: 100,
      percent: 99,
    });

    expect(screen.queryByText("Downloading the fallback engine…")).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByTestId("fallback-engine-installed")).toBeTruthy();
    expect(screen.getByTestId("fallback-engine-action").textContent).toContain(
      "Reinstall",
    );
  });

  it("accepts progress again for the NEXT install after settling", async () => {
    // The settle gate must not be a one-way latch: a second install has to be
    // able to show its own progress.
    let resolveSecondInstall!: (value: unknown) => void;
    invokeMock.mockImplementation((command: string) => {
      if (command === STATUS_COMMAND) return Promise.resolve(installed());
      return new Promise((resolve) => {
        resolveSecondInstall = resolve;
      });
    });

    render(<FallbackEngineSection />);
    await waitFor(() => {
      expect(
        screen.getByTestId("fallback-engine-action").textContent,
      ).toContain("Reinstall");
    });

    // Second install (pending).
    fireEvent.click(screen.getByTestId("fallback-engine-action"));
    await pushProgress({
      stage: "downloading",
      downloaded: 10,
      total: 100,
      percent: 10,
    });

    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "10",
    );

    await act(async () => {
      resolveSecondInstall(installed());
      await Promise.resolve();
    });
  });
});
