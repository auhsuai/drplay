// Google Drive "root" folder id — the Drive API uses the literal 'root' as
// the sentinel for the authenticated user's My Drive root.
export const ROOT_FOLDER_ID = "root";

// 'My Drive' is both the My Drive tab id and the display name used for the
// Drive root folder's currentFolderName value. Mirrored across the modules
// that historically kept their own copy (App.tsx, useDrive, useLocateFile,
// usePlayerQueue, driveStore).
export const MY_DRIVE_TAB = "My Drive";

// Single source of truth for every static tab id.
export const TABS = {
  home: "Home",
  myDrive: MY_DRIVE_TAB,
  settings: "Settings",
} as const;

export type TabKey = (typeof TABS)[keyof typeof TABS];

// Google Drive files.list caps each request at 1000 results (docs: values
// above 1000 are coerced to 1000). Single source of truth for the page size
// used by the paginated listers in drivePagination.
export const PAGINATION_PAGE_SIZE = 1000;

// Worst-case safety cap shared by the UI-layer pageToken loops
// (useDriveOnDemandFetch, getRecentlyAddedAudioFiles): 10 pages x
// PAGINATION_PAGE_SIZE = up to 10,000 results per query. Guards against a
// misbehaving server that keeps issuing nextPageToken forever.
// NOTE: drivePagination.ts keeps its own private copy of the same value —
// that module's loop is out of scope for this constant (refactor boundary).
export const MAX_PAGINATION_PAGES = 10;
