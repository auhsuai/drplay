// Human-readable byte formatting shared by UI surfaces that display sizes
// (sidebar Drive storage quota, etc.). 1024-based units up to terabytes.
// Drive quota fields are int64 byte counts — see the about resource docs
// (developers.google.com/workspace/drive/api/reference/rest/v3/about).
const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;
const BYTES_PER_UNIT = 1024;

export function formatBytes(bytes: number, fractionDigits = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  let value = bytes;
  let unitIndex = 0;
  while (value >= BYTES_PER_UNIT && unitIndex < BYTE_UNITS.length - 1) {
    value /= BYTES_PER_UNIT;
    unitIndex++;
  }
  // Trim a trailing ".0" so whole units read naturally ("15 GB" not "15.0 GB").
  let digits = value.toFixed(fractionDigits).replace(/\.0+$/, "");
  // Rounding up can push the displayed value to 1024 (1_048_536 B → "1024 KB"):
  // promote one more unit so ~1MB never renders as "1024 KB". A single promote
  // suffices — the divided value is < 1.000… so it can only land on "1".
  if (Number(digits) >= BYTES_PER_UNIT && unitIndex < BYTE_UNITS.length - 1) {
    unitIndex++;
    digits = (value / BYTES_PER_UNIT)
      .toFixed(fractionDigits)
      .replace(/\.0+$/, "");
  }
  return `${digits} ${BYTE_UNITS[unitIndex] ?? "B"}`;
}
