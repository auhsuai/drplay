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

// Progress listener: `listen` hands back an UnlistenFn and the test pushes
// payloads through the captured handler, exactly like the real event bus.
const eventMocks = vi.hoisted(() => ({
  listen: vi.fn(),
  // Real `listen` hands the handler a Tauri Event: { event, id, payload }.
  handlers: [] as Array<(event: { payload: unknown }) => void>,
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

async function pushProgress(payload: unknown): Promise<void> {
  await act(async () => {
    for (const handler of [...eventMocks.handlers]) handler({ payload });
    await Promise.resolve();
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  toastMocks.showErrorToast.mockReset();
  toastMocks.showSuccessToast.mockReset();
  errorMocks.captureError.mockReset();
  eventMocks.listen.mockReset();
  eventMocks.handlers.length = 0;
  eventMocks.listen.mockImplementation(
    (_name: string, handler: (event: { payload: unknown }) => void) => {
      eventMocks.handlers.push(handler);
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

    expect(
      await screen.findByText("mpv.exe fallback engine"),
    ).toBeTruthy();
    expect(
      screen.getByText(/This component is optional/),
    ).toBeTruthy();
    // The pinned build is named BEFORE the download, from the status DTO.
    expect(screen.getByText(`Pinned build: ${PINNED}`)).toBeTruthy();
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
    expect(screen.getByText(/Checking whether the fallback engine/)).toBeTruthy();
    expect(screen.queryByText(/This component is optional/)).toBeNull();

    await act(async () => {
      resolveStatus(notInstalled());
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByTestId("fallback-engine-checking")).toBeNull();
    });
    expect(screen.getByText(/This component is optional/)).toBeTruthy();
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
    expect(screen.getByText(`Pinned build: ${PINNED}`)).toBeTruthy();
  });
});

describe("FallbackEngineSection — progress", () => {
  // (5a) Determinate: the bar carries the real percentage.
  it("renders a determinate progressbar at 25% with transferred/total", async () => {
    routeInvoke({
      install: () => new Promise<unknown>(() => {}),
    });
    render(<FallbackEngineSection />);
    fireEvent.click(
      await screen.findByTestId("fallback-engine-action"),
    );

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
    expect(screen.getByTestId("fallback-engine-progress-text").textContent).toBe(
      "25%",
    );
    // formatBytes: 12 B and 48 B stay bytes.
    expect(
      screen.getByTestId("fallback-engine-progress-bytes").textContent,
    ).toBe("12 B of 48 B");
  });

  // (5b) Indeterminate: percent null -> no fabricated number.
  it("renders an indeterminate bar with no percentage when percent is null", async () => {
    routeInvoke({
      install: () => new Promise<unknown>(() => {}),
    });
    render(<FallbackEngineSection />);
    fireEvent.click(
      await screen.findByTestId("fallback-engine-action"),
    );

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
    fireEvent.click(
      await screen.findByTestId("fallback-engine-action"),
    );

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

    fireEvent.click(
      await screen.findByTestId("fallback-engine-action"),
    );

    expect(
      await screen.findByText("Installed version: 0.40.0.0"),
    ).toBeTruthy();
    expect(screen.getByText("Size on disk: 116.3 MB")).toBeTruthy();
    // "installed" alone never claims use: libmpv is the active engine.
    expect(
      screen.getByText(/This device is using libmpv\./),
    ).toBeTruthy();
    expect(screen.queryByText(/currently using the fallback engine/)).toBeNull();
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

    expect(
      await screen.findByText("This device is currently using the fallback engine."),
    ).toBeTruthy();
    expect(
      screen.queryByText(/This device is using libmpv\./),
    ).toBeNull();
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

    expect(
      await screen.findByText(/No playback engine is available/),
    ).toBeTruthy();
    expect(
      screen.getByText(/libmpv could not start and no fallback engine/),
    ).toBeTruthy();
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
        screen.getByTestId<HTMLButtonElement>("fallback-engine-action").disabled,
      ).toBe(true);
    });

    await act(async () => {
      resolveInstall(installed());
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(
        screen.getByTestId<HTMLButtonElement>("fallback-engine-action").disabled,
      ).toBe(false);
    });
  });
});

describe("FallbackEngineSection — errors", () => {
  // (9) Error is persistent, localized per code, and Retry re-invokes.
  it("shows a persistent localized error with the raw text and retries on demand", async () => {
    routeInvoke({
      install: () =>
        rejectWire("checksum_mismatch: the archive failed its integrity check"),
    });
    render(<FallbackEngineSection />);
    fireEvent.click(
      await screen.findByTestId("fallback-engine-action"),
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "The downloaded file failed its integrity check",
    );
    // Raw backend text is appended for diagnostics.
    expect(alert.textContent).toContain("checksum_mismatch: the archive");
    expect(toastMocks.showErrorToast).toHaveBeenCalledWith(
      "Couldn't install the fallback engine. Try again.",
      { duration: 4000 },
    );
    // Stays on screen (no auto-dismiss, no timer).
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("alert")).toBeTruthy();

    // Retry is a real second install.
    routeInvoke({ install: () => Promise.resolve(installed()) });
    fireEvent.click(screen.getByTestId("fallback-engine-retry"));
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
    fireEvent.click(
      await screen.findByTestId("fallback-engine-action"),
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "The fallback engine couldn't be installed.",
    );
    expect(alert.textContent).toContain("brand_new_code: something odd");
  });

  // (10) A failed UPDATE keeps the previously installed facts visible.
  it("keeps the installed facts visible when a later install fails", async () => {
    routeInvoke({
      status: () => Promise.resolve(installed({ engine: "legacy" })),
      install: () => rejectWire("network: connection reset"),
    });
    render(<FallbackEngineSection />);

    // Installed facts are on screen first.
    expect(
      await screen.findByText("Installed version: 0.40.0.0"),
    ).toBeTruthy();
    expect(screen.getByText("Size on disk: 116.3 MB")).toBeTruthy();

    fireEvent.click(screen.getByTestId("fallback-engine-action"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't reach the download server");
    // The facts did NOT get replaced by an error state.
    expect(screen.getByText("Installed version: 0.40.0.0")).toBeTruthy();
    expect(screen.getByText("Size on disk: 116.3 MB")).toBeTruthy();
    expect(
      screen.getByText("This device is currently using the fallback engine."),
    ).toBeTruthy();
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
    expect(screen.queryByText(/This component is optional/)).toBeNull();
    // Retry re-reads the status instead of trying to install blindly.
    routeInvoke({ status: () => Promise.resolve(notInstalled()) });
    fireEvent.click(screen.getByTestId("fallback-engine-retry"));
    await waitFor(() => {
      expect(screen.getByText(/This component is optional/)).toBeTruthy();
    });
    expect(installCalls()).toBe(0);
  });
});

describe("FallbackEngineSection — listener lifecycle", () => {
  // (12) Unmount runs the captured UnlistenFn.
  it("removes the progress event listener on unmount", async () => {
    const unlisten = vi.fn();
    eventMocks.listen.mockImplementation(
      (_name: string, handler: (event: { payload: unknown }) => void) => {
        eventMocks.handlers.push(handler);
        return Promise.resolve(unlisten);
      },
    );

    const { unmount } = render(<FallbackEngineSection />);
    await waitFor(() => {
      expect(eventMocks.listen).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      await Promise.resolve();
    });

    unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
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
