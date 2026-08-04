import { describe, it, expect, vi } from "vitest";
import { useDriveStore } from "./driveStore";

// Regression for the My Drive empty-state flash (RC-B): the store used to
// initialize isLoadingTracks=false, so the first render of MainContent showed
// the "no audio" empty state for one frame before useDriveExplorer flipped
// loading on. The store must start loading=true so the skeleton renders from
// the very first commit.
describe("driveStore isLoadingTracks initial contract", () => {
  it("ships with isLoadingTracks = true (skeleton from the first render, no empty-state flash)", async () => {
    // The store is a module singleton; a fresh module instance via
    // resetModules exposes the true shipped initial value regardless of what
    // earlier tests in this file set.
    vi.resetModules();
    const { useDriveStore: freshStore } = await import("./driveStore");
    expect(freshStore.getState().isLoadingTracks).toBe(true);
  });

  it("setIsLoadingTracks(false) turns loading off once data has arrived", () => {
    useDriveStore.setState({ isLoadingTracks: true });
    useDriveStore.getState().setIsLoadingTracks(false);
    expect(useDriveStore.getState().isLoadingTracks).toBe(false);
  });
});
