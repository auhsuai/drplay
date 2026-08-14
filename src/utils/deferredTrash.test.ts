import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Track } from "../types";
import { trashOrDefer, isDeferredTrash } from "./deferredTrash";

const mocks = vi.hoisted(() => {
  const handlers: {
    ended: Array<() => void>;
    play: Array<() => void>;
  } = {
    ended: [],
    play: [],
  };
  return {
    handlers,
    audio: { on: vi.fn() },
    playerStore: { getState: vi.fn() },
    driveApi: { deleteFile: vi.fn() },
    captureError: vi.fn(),
  };
});

vi.mock("../lib/AudioController", () => ({
  AudioController: { getInstance: () => mocks.audio },
}));
vi.mock("../store/playerStore", () => ({
  usePlayerStore: mocks.playerStore,
}));
vi.mock("./driveApi", () => mocks.driveApi);
vi.mock("./errorLog", () => ({ captureError: mocks.captureError }));

function setCurrentTrack(id: string | null) {
  mocks.playerStore.getState.mockReturnValue({
    currentTrack: id === null ? null : ({ id } as Track),
  });
}

function emit(event: "ended" | "play") {
  for (const handler of [...mocks.handlers[event]]) handler();
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.handlers.ended = [];
  mocks.handlers.play = [];
  mocks.audio.on.mockImplementation(
    (event: string, handler: () => void): (() => void) => {
      mocks.handlers[event as "ended" | "play"].push(handler);
      return () => {
        const list = mocks.handlers[event as "ended" | "play"];
        const idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
      };
    },
  );
  mocks.driveApi.deleteFile.mockResolvedValue({ id: "x" });
  setCurrentTrack(null);
});

describe("trashOrDefer", () => {
  it("trashes immediately (exactly once) when the file is NOT the current track", async () => {
    setCurrentTrack("other-track");
    await trashOrDefer("file-1", "tok-1");
    expect(mocks.driveApi.deleteFile).toHaveBeenCalledTimes(1);
    expect(mocks.driveApi.deleteFile).toHaveBeenCalledWith("tok-1", "file-1");
    expect(mocks.audio.on).not.toHaveBeenCalled();
    expect(isDeferredTrash("file-1")).toBe(false);
  });

  it("defers when the file IS the current track — no immediate Drive trash", async () => {
    setCurrentTrack("def-1");
    await trashOrDefer("def-1", "tok-1");
    expect(mocks.driveApi.deleteFile).not.toHaveBeenCalled();
    expect(mocks.audio.on).toHaveBeenCalledTimes(2);
    expect(isDeferredTrash("def-1")).toBe(true);
  });

  it("trashes with the right fileId+token when the track ends (ended)", async () => {
    setCurrentTrack("ended-1");
    await trashOrDefer("ended-1", "tok-1");
    emit("ended");
    await vi.waitFor(() => {
      expect(mocks.driveApi.deleteFile).toHaveBeenCalledWith(
        "tok-1",
        "ended-1",
      );
    });
    expect(mocks.driveApi.deleteFile).toHaveBeenCalledTimes(1);
    expect(isDeferredTrash("ended-1")).toBe(false);
    // Listener pair is unsubscribed after fire — further emits change nothing.
    emit("ended");
    emit("play");
    expect(mocks.driveApi.deleteFile).toHaveBeenCalledTimes(1);
  });

  it("trashes when the user moves to another track (play after switch)", async () => {
    setCurrentTrack("switched-1");
    await trashOrDefer("switched-1", "tok-1");
    setCurrentTrack("next-track");
    emit("play");
    await vi.waitFor(() => {
      expect(mocks.driveApi.deleteFile).toHaveBeenCalledWith(
        "tok-1",
        "switched-1",
      );
    });
    expect(mocks.driveApi.deleteFile).toHaveBeenCalledTimes(1);
    expect(isDeferredTrash("switched-1")).toBe(false);
  });

  it("does NOT trash when play fires on a resume of the SAME track — stream would break", async () => {
    setCurrentTrack("resume-1");
    await trashOrDefer("resume-1", "tok-1");
    emit("play");
    expect(mocks.driveApi.deleteFile).not.toHaveBeenCalled();
    expect(isDeferredTrash("resume-1")).toBe(true);
    // Still deferred — the real end of the track must trash it.
    emit("ended");
    await vi.waitFor(() => {
      expect(mocks.driveApi.deleteFile).toHaveBeenCalledWith(
        "tok-1",
        "resume-1",
      );
    });
  });

  it("registers only ONE listener pair when deferred twice for the same file", async () => {
    setCurrentTrack("dup-1");
    await trashOrDefer("dup-1", "tok-1");
    await trashOrDefer("dup-1", "tok-1");
    expect(mocks.audio.on).toHaveBeenCalledTimes(2);
    setCurrentTrack("next-track");
    emit("play");
    emit("ended");
    await vi.waitFor(() => {
      expect(mocks.driveApi.deleteFile).toHaveBeenCalledTimes(1);
    });
    expect(mocks.driveApi.deleteFile).toHaveBeenCalledWith("tok-1", "dup-1");
    expect(isDeferredTrash("dup-1")).toBe(false);
  });

  it("captures a warn (no toast, no crash) when the deferred trash fails", async () => {
    mocks.driveApi.deleteFile.mockRejectedValue(new Error("network down"));
    setCurrentTrack("warn-1");
    await trashOrDefer("warn-1", "tok-1");
    emit("ended");
    await vi.waitFor(() => {
      expect(mocks.captureError).toHaveBeenCalledTimes(1);
    });
    expect(mocks.captureError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        source: "deferredTrash",
      }),
    );
    expect(isDeferredTrash("warn-1")).toBe(false);
  });

  it("isDeferredTrash mirrors the deferred state and clears after fire", async () => {
    expect(isDeferredTrash("guard-1")).toBe(false);
    setCurrentTrack("guard-1");
    await trashOrDefer("guard-1", "tok-1");
    expect(isDeferredTrash("guard-1")).toBe(true);
    emit("ended");
    await vi.waitFor(() => {
      expect(isDeferredTrash("guard-1")).toBe(false);
    });
  });
});
