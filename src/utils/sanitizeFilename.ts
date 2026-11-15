// Windows file-name sanitization, shared by the single-file download (and,
// from Step 2, folder downloads, which need it for folder names too).
//
// Windows forbids these characters in file names; also guard against DOS
// device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9) and trailing dots/spaces.
// Copied verbatim from the removed GlobalContextMenu.tsx (the last known-good
// download implementation) so the written name matches what worked before.
// \p{Cc} matches Unicode control characters (incl. C0 \x00-\x1F plus the C1
// range \x7F-\x9F) — slightly wider than the old literal class, but avoids
// eslint no-control-regex (control chars cannot be written in a regex literal)
// and is strictly safer for Windows file names.
export const sanitizeFilename = (
  name: string,
  fallbackName: string = "untitled",
): string => {
  let s = name.replace(/[/\\<>:"|?*\p{Cc}]/gu, "_");
  s = s.replace(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i, "_$1$2");
  s = s.replace(/[\s.]+$/g, "");
  s = s.slice(0, 255);
  return s || fallbackName;
};
