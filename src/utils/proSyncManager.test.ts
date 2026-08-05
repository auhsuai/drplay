import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleWorkerMessage,
  setTokenRefreshHandler,
  startProSyncWorker,
  stopProSyncWorker,
  SYNC_EVENT_NAMES as EVENT,
} from "./proSyncManager";
import type { ProSyncHandlerDeps, WorkerMsgType } from "./proSyncManager";
import { captureError } from "./errorLog";

vi.mock("./errorLog", () => ({ captureError: vi.fn() }));

function makeDeps(overrides: Partial<ProSyncHandlerDeps> = {}): {
  deps: ProSyncHandlerDeps;
  updateToken: ReturnType<typeof vi.fn>;
  dispatch: ReturnType<typeof vi.fn>;
  logError: ReturnType<typeof vi.fn>;
} {
  const updateToken = vi.fn();
  const dispatch = vi.fn();
  const logError = vi.fn();
  const deps: ProSyncHandlerDeps = {
    onTokenRefreshRequest: null,
    updateToken,
    dispatch,
    logError,
    ...overrides,
  };
  return { deps, updateToken, dispatch, logError };
}

describe("handleWorkerMessage", () => {
  it("TOKEN_EXPIRED with successful refresh calls updateToken and nothing else", async () => {
    const onTokenRefreshRequest = vi.fn().mockResolvedValue("new-token");
    const { deps, updateToken, dispatch, logError } = makeDeps({
      onTokenRefreshRequest,
    });

    await handleWorkerMessage({ type: "TOKEN_EXPIRED" }, deps);

    expect(onTokenRefreshRequest).toHaveBeenCalledTimes(1);
    expect(updateToken).toHaveBeenCalledWith("new-token");
    expect(dispatch).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });

  it("TOKEN_EXPIRED with null refresh result does not call updateToken", async () => {
    const onTokenRefreshRequest = vi.fn().mockResolvedValue(null);
    const { deps, updateToken, dispatch, logError } = makeDeps({
      onTokenRefreshRequest,
    });

    await handleWorkerMessage({ type: "TOKEN_EXPIRED" }, deps);

    expect(onTokenRefreshRequest).toHaveBeenCalledTimes(1);
    expect(updateToken).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });

  it("TOKEN_EXPIRED with no refresh handler does nothing", async () => {
    const { deps, updateToken, dispatch, logError } = makeDeps();

    await handleWorkerMessage({ type: "TOKEN_EXPIRED" }, deps);

    expect(updateToken).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });

  it("TOKEN_EXPIRED with throwing refresh handler logs the error instead of propagating", async () => {
    const onTokenRefreshRequest = vi
      .fn()
      .mockRejectedValue(new Error("refresh blew up"));
    const { deps, updateToken, dispatch, logError } = makeDeps({
      onTokenRefreshRequest,
    });

    await handleWorkerMessage({ type: "TOKEN_EXPIRED" }, deps);

    expect(updateToken).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("refresh"));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("SYNC_PROGRESS dispatches progress event without logging", async () => {
    const { deps, dispatch, logError } = makeDeps();

    await handleWorkerMessage({ type: "SYNC_PROGRESS" }, deps);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(EVENT.progress);
    expect(logError).not.toHaveBeenCalled();
  });

  it("SYNC_COMPLETE dispatches complete event without logging", async () => {
    const { deps, dispatch, logError } = makeDeps();

    await handleWorkerMessage({ type: "SYNC_COMPLETE" }, deps);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(EVENT.complete);
    expect(logError).not.toHaveBeenCalled();
  });

  it("SYNC_BUSY dispatches busy event without logging (not an error)", async () => {
    const { deps, dispatch, logError } = makeDeps();

    await handleWorkerMessage({ type: "SYNC_BUSY" }, deps);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(EVENT.busy);
    expect(logError).not.toHaveBeenCalled();
  });

  it("SYNC_NO_TOKEN logs the failure and dispatches no-token event", async () => {
    const { deps, dispatch, logError } = makeDeps();

    await handleWorkerMessage({ type: "SYNC_NO_TOKEN" }, deps);

    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith(
      "pro-sync: no token provided to worker",
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(EVENT.noToken);
  });

  it("SYNC_ERROR logs the failure and dispatches error event", async () => {
    const { deps, dispatch, logError } = makeDeps();

    await handleWorkerMessage({ type: "SYNC_ERROR" }, deps);

    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith("pro-sync: worker sync failed");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(EVENT.error);
  });

  it("unknown message type is ignored safely", async () => {
    const { deps, updateToken, dispatch, logError } = makeDeps();

    await handleWorkerMessage(
      { type: "SOME_FUTURE_TYPE" as string as WorkerMsgType },
      deps,
    );
    await handleWorkerMessage({}, deps);

    expect(updateToken).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });
});

class FakeWorker {
  static instances: FakeWorker[] = [];

  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: ((e: MessageEvent) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();

  constructor(_url: string | URL, _options?: WorkerOptions) {
    void _url;
    void _options;
    FakeWorker.instances.push(this);
  }
}

describe("startProSyncWorker", () => {
  let dispatchEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    FakeWorker.instances = [];
    dispatchEvent = vi.fn();
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("window", { dispatchEvent });
    vi.stubGlobal(
      "CustomEvent",
      class {
        type: string;
        constructor(type: string) {
          this.type = type;
        }
      },
    );
    vi.mocked(captureError).mockReset();
  });

  afterEach(() => {
    stopProSyncWorker();
    vi.unstubAllGlobals();
  });

  function lastWorker() {
    const worker = FakeWorker.instances[FakeWorker.instances.length - 1];
    if (worker === undefined) throw new Error("expected a FakeWorker instance");
    return worker;
  }

  it("attaches onmessage, onerror and onmessageerror handlers", () => {
    startProSyncWorker("token");

    const worker = lastWorker();
    expect(worker).toBeDefined();
    expect(typeof worker.onmessage).toBe("function");
    expect(typeof worker.onerror).toBe("function");
    expect(typeof worker.onmessageerror).toBe("function");
  });

  it("logs worker runtime errors via captureError and dispatches the error event", () => {
    startProSyncWorker("token");
    const worker = lastWorker();

    worker.onerror?.({ message: "Script load failed" } as ErrorEvent);

    expect(captureError).toHaveBeenCalledTimes(1);
    expect(captureError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        source: "proSyncManager",
        message: "worker-error: Script load failed",
      }),
    );
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "pro-sync-error" }),
    );
  });

  it("logs messageerror without dispatching a UI event", () => {
    startProSyncWorker("token");
    const worker = lastWorker();

    worker.onmessageerror?.({} as MessageEvent);

    expect(captureError).toHaveBeenCalledTimes(1);
    expect(captureError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        source: "proSyncManager",
        message: "worker-messageerror: malformed message from worker",
      }),
    );
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it("TOKEN_EXPIRED with registered handler posts the refreshed token to the worker", async () => {
    setTokenRefreshHandler(() => Promise.resolve("new-token"));
    startProSyncWorker("token");
    const worker = lastWorker();

    worker.onmessage?.({ data: { type: "TOKEN_EXPIRED" } });
    await Promise.resolve();
    await Promise.resolve();

    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    expect(worker.postMessage).toHaveBeenLastCalledWith({
      type: "token",
      token: "new-token",
    });
  });

  it("setTokenRefreshHandler(null) prevents a restarted worker from reusing the stale handler", async () => {
    setTokenRefreshHandler(() => Promise.resolve("stale-token"));
    startProSyncWorker("token");
    setTokenRefreshHandler(null);
    stopProSyncWorker();
    startProSyncWorker("token");
    const worker = lastWorker();

    worker.onmessage?.({ data: { type: "TOKEN_EXPIRED" } });
    await Promise.resolve();
    await Promise.resolve();

    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(worker.postMessage).toHaveBeenCalledWith({
      type: "sync",
      token: "token",
    });
  });
});
