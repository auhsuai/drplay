// Google Drive "root" folder id — the Drive API uses the literal 'root' as
// the sentinel for the authenticated user's My Drive root.
export const ROOT_FOLDER_ID = "root";

// 'My Drive' is both the My Drive tab id and the display name used for the
// Drive root folder's currentFolderName value. Mirrored across the modules
// that historically kept their own copy (App.tsx, useDrive, useLocateFile,
// usePlayerQueue, driveStore).
export const MY_DRIVE_TAB = "My Drive";

// Single source of truth for every static tab id. Playlist tabs
// (`playlist_${id}`) are dynamic — one per user playlist — and are covered by
// the `playlist_${string}` member of TabKey below, not by this object.
export const TABS = {
  home: "Home",
  myDrive: MY_DRIVE_TAB,
  likedSongs: "Liked Songs",
  settings: "Settings",
} as const;

export type TabKey = (typeof TABS)[keyof typeof TABS] | `playlist_${string}`;

// Google Drive files.list caps each request at 1000 results (docs: values
// above 1000 are coerced to 1000). Single source of truth for the page size
// used by the paginated listers in drivePagination.
export const PAGINATION_PAGE_SIZE = 1000;
