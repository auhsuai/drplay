// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { db, type DriveFile } from "../db/db";
import { useDriveListing } from "./useDriveListing";
import { useDriveStore } from "../store/driveStore";
import { useAuthStore } from "../store/authStore";
import { USER_EMAIL_KEY } from "../utils/storageKeys";

// S-01: `useLiveQuery` must re-scope on the ACCOUNT email, not only on the
// folder id. An in-session account switch keeps `currentFolderId` unchanged,
// so a folder-id-only dep array never re-runs the query and account A's rows
// keep rendering. The identity guard is what stops the one stale frame
// dexie-react-hooks keeps in `monitor.current.result` after the dep change.
//
// All scenarios keep `currentFolderId` frozen and assert on the IDS (a count
// assertion would pass with the wrong owner).

const FOLDER_ID = "folder-shared";
const A_EMAIL = "a@example.com";
const B_EMAIL = "b@example.com";

function makeRow(
  id: string,
  parentId: string,
  userEmail: string,
  name = `${id}.mp3`,
): DriveFile {
  return {
    id,
    name,
    mimeType: "audio/mpeg",
    parentId,
    trashed: false,
    isFolder: false,
    modifiedTime: "2024-01-01T00:00:00.000Z",
    size: 1000,
    userEmail,
  };
}

function setAccount(email: string | null): void {
  if (email === null) {
    // Logout order mirrors logoutCleanup.ts: the LS key is removed BEFORE
    // clearLoginState(), so the render triggered by the store clear already
    // reads the "default" fallback (the audit's documented logout path).
    localStorage.removeItem(USER_EMAIL_KEY);
    act(() => {
      useAuthStore.setState({ userProfile: null });
    });
    return;
  }
  // Login order mirrors useAuthProfileSync: store first, then localStorage.
  act(() => {
    useAuthStore.setState({
      userProfile: { name: email, email, picture: "" },
    });
  });
  localStorage.setItem(USER_EMAIL_KEY, email);
}

function renderListing() {
  return renderHook(() =>
    useDriveListing({
      currentFolderId: FOLDER_ID,
      currentFolderName: "Shared",
      sortOption: "name",
    }),
  );
}

const ids = (list: { id: string }[]): string[] => list.map((i) => i.id);

describe("useDriveListing account scope (S-01)", () => {
  beforeEach(async () => {
    localStorage.clear();
    await db.files.clear();
    await db.metadataCache.clear();
    act(() => {
      useDriveStore.setState({
        rootFolders: [{ id: "root", name: "My Drive" }],
      });
      useAuthStore.setState({ userProfile: null });
    });
  });

  afterEach(async () => {
    await db.files.clear();
    await db.metadataCache.clear();
    localStorage.clear();
    act(() => {
      useDriveStore.setState({ rootFolders: [] });
      useAuthStore.setState({ userProfile: null });
    });
  });

  it("A: account A -> B (same folder) never paints A's rows, settles on B's", async () => {
    await db.files.bulkPut([
      makeRow("a-file", FOLDER_ID, A_EMAIL),
      makeRow("b-file", FOLDER_ID, B_EMAIL),
    ]);
    setAccount(A_EMAIL);

    const view = renderListing();
    await waitFor(() => {
      expect(ids(view.result.current.items)).toEqual(["a-file"]);
    });

    // Flip BOTH identity sources (store first, then LS) like useAuthProfileSync.
    setAccount(B_EMAIL);

    // The retained previous result must not paint: no stale A frame at all.
    expect(ids(view.result.current.items)).not.toContain("a-file");

    await waitFor(() => {
      expect(ids(view.result.current.items)).toEqual(["b-file"]);
    });
    expect(ids(view.result.current.items)).not.toContain("a-file");
    view.unmount();
  });

  it("B: account B -> A (same folder) never paints B's rows, settles on A's", async () => {
    await db.files.bulkPut([
      makeRow("a-file", FOLDER_ID, A_EMAIL),
      makeRow("b-file", FOLDER_ID, B_EMAIL),
    ]);
    setAccount(B_EMAIL);

    const view = renderListing();
    await waitFor(() => {
      expect(ids(view.result.current.items)).toEqual(["b-file"]);
    });

    setAccount(A_EMAIL);

    expect(ids(view.result.current.items)).not.toContain("b-file");

    await waitFor(() => {
      expect(ids(view.result.current.items)).toEqual(["a-file"]);
    });
    expect(ids(view.result.current.items)).not.toContain("b-file");
    view.unmount();
  });

  it("C: logout then login as B shows [] during logout (never A rows), then B's", async () => {
    await db.files.bulkPut([
      makeRow("a-file", FOLDER_ID, A_EMAIL),
      makeRow("b-file", FOLDER_ID, B_EMAIL),
    ]);
    setAccount(A_EMAIL);

    const view = renderListing();
    await waitFor(() => {
      expect(ids(view.result.current.items)).toEqual(["a-file"]);
    });

    // Mirrors logoutCleanup: LS key removed, store profile cleared, then the
    // per-account row wipe (fire-and-forget there; awaited here).
    setAccount(null);
    await db.files.where("userEmail").equals(A_EMAIL).delete();

    expect(ids(view.result.current.items)).toEqual([]);

    await waitFor(() => {
      expect(ids(view.result.current.items)).toEqual([]);
    });
    expect(ids(view.result.current.items)).not.toContain("a-file");

    setAccount(B_EMAIL);

    await waitFor(() => {
      expect(ids(view.result.current.items)).toEqual(["b-file"]);
    });
    view.unmount();
  });

  it("D: no store profile and no LS key falls back to the 'default' owner", async () => {
    await db.files.bulkPut([
      makeRow("default-file", FOLDER_ID, "default"),
      makeRow("a-file", FOLDER_ID, A_EMAIL),
    ]);

    const view = renderListing();

    await waitFor(() => {
      expect(ids(view.result.current.items)).toEqual(["default-file"]);
    });
    expect(ids(view.result.current.items)).not.toContain("a-file");
    view.unmount();
  });

  it("E: a no-op re-render keeps the same dbFiles reference (no query churn, no flicker)", async () => {
    await db.files.bulkPut([makeRow("a-file", FOLDER_ID, A_EMAIL)]);
    setAccount(A_EMAIL);

    const view = renderListing();
    await waitFor(() => {
      expect(ids(view.result.current.items)).toEqual(["a-file"]);
    });

    const before = view.result.current.dbFiles;
    view.rerender();
    view.rerender();

    expect(view.result.current.dbFiles).toBe(before);
    expect(ids(view.result.current.items)).toEqual(["a-file"]);
    view.unmount();
  });
});
