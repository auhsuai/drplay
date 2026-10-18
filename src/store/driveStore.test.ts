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

describe("driveStore rootFolders contract", () => {
  it("ships with rootFolders = [] (no configured roots / legacy install)", async () => {
    vi.resetModules();
    const { useDriveStore: freshStore } = await import("./driveStore");
    expect(freshStore.getState().rootFolders).toEqual([]);
  });

  it("setRootFolders stores the ordered list as given", () => {
    useDriveStore.setState({ rootFolders: [] });
    useDriveStore.getState().setRootFolders([
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ]);
    expect(useDriveStore.getState().rootFolders).toEqual([
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ]);
  });

  it("setRootFolders([]) resets to the empty configuration", () => {
    useDriveStore.setState({ rootFolders: [{ id: "a", name: "A" }] });
    useDriveStore.getState().setRootFolders([]);
    expect(useDriveStore.getState().rootFolders).toEqual([]);
  });

  it("does not touch any other state field", () => {
    useDriveStore.setState({
      appRootFolder: "root-x",
      isHydrated: true,
      currentFolderId: "folder-1",
      currentFolderName: "Folder 1",
      folderHistory: [{ id: "folder-1", name: "Folder 1" }],
      sortOption: "modifiedTime desc",
      isLoadingTracks: false,
    });
    useDriveStore.getState().setRootFolders([{ id: "a", name: "A" }]);
    const state = useDriveStore.getState();
    expect(state.appRootFolder).toBe("root-x");
    expect(state.isHydrated).toBe(true);
    expect(state.currentFolderId).toBe("folder-1");
    expect(state.currentFolderName).toBe("Folder 1");
    expect(state.folderHistory).toEqual([{ id: "folder-1", name: "Folder 1" }]);
    expect(state.sortOption).toBe("modifiedTime desc");
    expect(state.isLoadingTracks).toBe(false);
  });
});
