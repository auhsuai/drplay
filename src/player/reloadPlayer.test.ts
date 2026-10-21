// Orchestration contract for the F5 / Ctrl+R reload: persist the session,
// invalidate in-flight intents, await the native mpv shutdown, clear the
// one-shot restore hint, then reload. Every side effect is injected so the
// ORDER (not just the presence) is pinned here.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  shutdownForReload: vi.fn(),
  savePlayerSessionNow: vi.fn(),
  abortCurrentIntent: vi.fn(),
  bumpSessionEpoch: vi.fn(),
  clearRestoreResume: vi.fn(),
  resetAdvanceGuard: vi.fn(),
  captureError: vi.fn(),
  showErrorToast: vi.fn(),
  t: vi.fn((key: string) => key),
}));

vi.mock("../lib/AudioController", () => ({
  AudioController: {
    getInstance: () => ({ shutdownForReload: mocks.shutdownForReload }),
  },
}));

vi.mock("../hooks/player/usePlayerSession", () => ({
  savePlayerSessionNow: mocks.savePlayerSessionNow,
}));

vi.mock("../hooks/player/playbackIntent", () => ({
  abortCurrentIntent: mocks.abortCurrentIntent,
  bumpSessionEpoch: mocks.bumpSessionEpoch,
}));

vi.mock("../hooks/player/restoreResume", () => ({
  clearRestoreResume: mocks.clearRestoreResume,
}));

vi.mock("../utils/playerError", () => ({
  resetAdvanceGuard: mocks.resetAdvanceGuard,
}));

vi.mock("../utils/errorLog", () => ({
  captureError: mocks.captureError,
}));

vi.mock("../utils/simpleToast", () => ({
  showErrorToast: mocks.showErrorToast,
}));

vi.mock("i18next", () => ({
  default: { t: mocks.t },
}));

import {
  __resetPlayerReloadForTests,
  requestPlayerReload,
} from "./reloadPlayer";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetPlayerReloadForTests();
  mocks.t.mockImplementation((key: string) => key);
  mocks.shutdownForReload.mockResolvedValue(undefined);
});

describe("requestPlayerReload — ordered shutdown before the page reload", () => {
  it("runs save -> abort -> epoch bump -> await shutdown -> clear hint -> reset guard -> reload", async () => {
    const order: string[] = [];
    mocks.savePlayerSessionNow.mockImplementation(() => order.push("save"));
    mocks.abortCurrentIntent.mockImplementation(() => order.push("abort"));
    mocks.bumpSessionEpoch.mockImplementation(() => order.push("bump"));
    mocks.shutdownForReload.mockImplementation(() => {
      order.push("shutdown");
    });
    mocks.clearRestoreResume.mockImplementation(() => order.push("clear"));
    mocks.resetAdvanceGuard.mockImplementation(() => order.push("guard"));
    const reload = vi.fn(() => order.push("reload"));

    await requestPlayerReload(reload);

    expect(order).toEqual([
      "save",
      "abort",
      "bump",
      "shutdown",
      "clear",
      "guard",
      "reload",
    ]);
    // The snapshot must be persisted BEFORE the engine is released — otherwise
    // the reloaded page restores a position the engine already tore down.
    expect(order.indexOf("save")).toBeLessThan(order.indexOf("shutdown"));
  });

  it("does not reload when the native shutdown rejects; reports it and reopens the lock", async () => {
    mocks.shutdownForReload.mockRejectedValueOnce(new Error("mpv wedged"));
    const reload = vi.fn();

    await requestPlayerReload(reload);

    expect(reload).not.toHaveBeenCalled();
    expect(mocks.captureError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        source: "playerReload",
        message: expect.stringContaining("mpv wedged") as unknown as string,
      }),
    );
    expect(mocks.showErrorToast).toHaveBeenCalledTimes(1);
    expect(mocks.showErrorToast).toHaveBeenCalledWith("player.reload_failed");

    // The lock reopened: a later attempt runs the whole flow again.
    mocks.shutdownForReload.mockResolvedValueOnce(undefined);
    await requestPlayerReload(reload);

    expect(mocks.shutdownForReload).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("concurrent calls share one shutdown and one reload", async () => {
    const gate = deferred<undefined>();
    mocks.shutdownForReload.mockReturnValue(gate.promise);
    const reload = vi.fn();

    const first = requestPlayerReload(reload);
    const second = requestPlayerReload(reload);

    await Promise.resolve();
    expect(mocks.savePlayerSessionNow).toHaveBeenCalledTimes(1);
    expect(mocks.shutdownForReload).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();

    gate.resolve(undefined);
    await Promise.all([first, second]);

    expect(mocks.shutdownForReload).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);

    // Success keeps the lock closed (the page is about to go away).
    await requestPlayerReload(reload);
    expect(mocks.shutdownForReload).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
