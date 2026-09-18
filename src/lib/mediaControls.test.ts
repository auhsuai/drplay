// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isMediaControlPayload,
  listenMediaControls,
  updateMediaControls,
  MEDIA_CONTROL_EVENT,
  MEDIA_CONTROLS_UPDATE_COMMAND,
  type MediaControlsSnapshot,
} from "./mediaControls";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: unknown) => Promise<void>>(() =>
    Promise.resolve(),
  ),
  listen: vi.fn<
    (
      event: string,
      handler: (event: { payload: unknown }) => void,
    ) => Promise<() => void>
  >(() => Promise.resolve(() => {})),
  isTauri: vi.fn(() => true),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
  isTauri: tauriMocks.isTauri,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: tauriMocks.listen,
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

vi.mock("../utils/errorLog", () => errorLogMock);

function makeSnapshot(): MediaControlsSnapshot {
  return {
    revision: 1,
    title: "Song",
    artist: "Artist",
    duration: 240,
    playback: "playing",
    position: 10,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  tauriMocks.isTauri.mockReturnValue(true);
  tauriMocks.invoke.mockResolvedValue(undefined);
  tauriMocks.listen.mockResolvedValue(vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isMediaControlPayload", () => {
  it("nhận payload hợp lệ với mọi action trong contract", () => {
    for (const action of [
      "play",
      "pause",
      "toggle",
      "stop",
      "next",
      "previous",
      "seek",
      "seek-forward",
      "seek-backward",
    ]) {
      expect(isMediaControlPayload({ action })).toBe(true);
    }
    expect(isMediaControlPayload({ action: "seek", position: 12 })).toBe(true);
  });

  it("từ chối payload sai shape / action lạ", () => {
    expect(isMediaControlPayload(undefined)).toBe(false);
    expect(isMediaControlPayload(null)).toBe(false);
    expect(isMediaControlPayload("next")).toBe(false);
    expect(isMediaControlPayload({})).toBe(false);
    expect(isMediaControlPayload({ action: 7 })).toBe(false);
    expect(isMediaControlPayload({ action: "unknown-action" })).toBe(false);
  });
});

describe("updateMediaControls", () => {
  it("gửi snapshot qua invoke đúng command + payload", async () => {
    const snapshot = makeSnapshot();
    await updateMediaControls(snapshot);

    expect(tauriMocks.invoke).toHaveBeenCalledWith(
      MEDIA_CONTROLS_UPDATE_COMMAND,
      { update: snapshot },
    );
  });

  it("invoke reject → log qua captureError, KHÔNG throw", async () => {
    tauriMocks.invoke.mockRejectedValueOnce(new Error("ipc down"));

    await expect(updateMediaControls(makeSnapshot())).resolves.toBeUndefined();

    expect(errorLogMock.captureError).toHaveBeenCalledTimes(1);
    const entry = errorLogMock.captureError.mock.calls[0]?.[0];
    expect(entry?.level).toBe("warn");
    expect(entry?.source).toBe("mediaControls");
    expect(entry?.message).toContain("update-failed");
    expect(entry?.message).toContain("ipc down");
  });

  it("ngoài Tauri (browser dev/test) → no-op, không invoke", async () => {
    tauriMocks.isTauri.mockReturnValue(false);
    await updateMediaControls(makeSnapshot());
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
  });
});

describe("listenMediaControls", () => {
  it("payload hợp lệ → gọi handler; trả unlisten của listen", async () => {
    const unlisten = vi.fn();
    tauriMocks.listen.mockResolvedValueOnce(unlisten);
    const handler = vi.fn();

    const result = await listenMediaControls(handler);
    expect(tauriMocks.listen).toHaveBeenCalledWith(
      MEDIA_CONTROL_EVENT,
      expect.any(Function),
    );

    const listener = tauriMocks.listen.mock.calls[0]?.[1];
    listener?.({ payload: { action: "next" } });
    expect(handler).toHaveBeenCalledWith({ action: "next" });

    expect(result).toBe(unlisten);
  });

  it("payload sai shape → bỏ qua + log, không gọi handler", async () => {
    const handler = vi.fn();
    await listenMediaControls(handler);

    const listener = tauriMocks.listen.mock.calls[0]?.[1];
    listener?.({ payload: { action: "not-real" } });

    expect(handler).not.toHaveBeenCalled();
    expect(errorLogMock.captureError).toHaveBeenCalledTimes(1);
    const entry = errorLogMock.captureError.mock.calls[0]?.[0];
    expect(entry?.source).toBe("mediaControls");
    expect(entry?.message).toContain("malformed");
  });

  it("listen reject → log + trả unlisten rỗng (app vẫn chạy)", async () => {
    tauriMocks.listen.mockRejectedValueOnce(new Error("no ipc"));

    const unlisten = await listenMediaControls(vi.fn());
    expect(typeof unlisten).toBe("function");
    expect(() => {
      unlisten();
    }).not.toThrow();

    expect(errorLogMock.captureError).toHaveBeenCalledTimes(1);
    const entry = errorLogMock.captureError.mock.calls[0]?.[0];
    expect(entry?.source).toBe("mediaControls");
    expect(entry?.message).toContain("listen-failed");
  });

  it("ngoài Tauri → no-op, không listen", async () => {
    tauriMocks.isTauri.mockReturnValue(false);
    const handler = vi.fn();
    const unlisten = await listenMediaControls(handler);
    expect(tauriMocks.listen).not.toHaveBeenCalled();
    expect(() => {
      unlisten();
    }).not.toThrow();
  });
});
