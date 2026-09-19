import { beforeEach, describe, expect, it, vi } from "vitest";

const storeMocks = vi.hoisted(() => ({
  setIsPlaying: vi.fn(),
  getState: vi.fn(),
}));

vi.mock("./playerStore", () => ({
  usePlayerStore: { getState: storeMocks.getState },
}));

import {
  __resetPlaybackCommitSourceForTests,
  commitIsPlaying,
  getLastPlaybackCommitSource,
} from "./playbackCommit";

beforeEach(() => {
  vi.clearAllMocks();
  storeMocks.getState.mockReturnValue({
    setIsPlaying: storeMocks.setIsPlaying,
  });
  __resetPlaybackCommitSourceForTests();
});

describe("commitIsPlaying", () => {
  it("routes the value unchanged to usePlayerStore.getState().setIsPlaying", () => {
    commitIsPlaying("intent", true);
    expect(storeMocks.getState).toHaveBeenCalledTimes(1);
    expect(storeMocks.setIsPlaying).toHaveBeenNthCalledWith(1, true);

    commitIsPlaying("intent", false);
    expect(storeMocks.setIsPlaying).toHaveBeenNthCalledWith(2, false);
    expect(storeMocks.getState).toHaveBeenCalledTimes(2);
  });

  it("records the source of the most recent commit", () => {
    expect(getLastPlaybackCommitSource()).toBeNull();

    commitIsPlaying("intent", true);
    expect(getLastPlaybackCommitSource()).toBe("intent");

    commitIsPlaying("policy", false);
    expect(getLastPlaybackCommitSource()).toBe("policy");

    commitIsPlaying("teardown", false);
    expect(getLastPlaybackCommitSource()).toBe("teardown");

    commitIsPlaying("engine", true);
    expect(getLastPlaybackCommitSource()).toBe("engine");
  });

  it("__resetPlaybackCommitSourceForTests clears the recorded source", () => {
    commitIsPlaying("engine", true);
    __resetPlaybackCommitSourceForTests();
    expect(getLastPlaybackCommitSource()).toBeNull();
  });
});
