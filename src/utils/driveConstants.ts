// Google Drive "root" folder id — the Drive API uses the literal 'root' as
// the sentinel for the authenticated user's My Drive root.
export const ROOT_FOLDER_ID = 'root';

// 'My Drive' is both the My Drive tab id and the display name used for the
// Drive root folder's currentFolderName value. Mirrored across the modules
// that historically kept their own copy (App.tsx, useDrive, useLocateFile,
// usePlayerQueue, driveStore).
export const MY_DRIVE_TAB = 'My Drive';
