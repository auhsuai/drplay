import { useTranslation } from "react-i18next";
import {
  LIST_ACTIONS_TRACK,
  LIST_DATE_TRACK,
  LIST_GAP,
  LIST_HEADER_PADDING,
  LIST_ICON_TRACK,
  LIST_SIZE_TRACK,
} from "./listColumnLayout";

export interface FileListHeaderProps {
  /** Full sort string from driveStore ("name", "modifiedTime desc", …). */
  sortOption: string;
  /** Same chain TabContentRouter persists (store + drplay_sort_option LS). */
  onSortChange?: (option: string) => void;
}

// aria-sort value for one column header given the full sort string. Columns
// that are not the active base report "none" (ARIA: a sortable column header
// declares a direction only while it owns the sort). An unknown base (garbage
// LS value like "name_natural") leaves every column at "none" — honest and
// safe (the same tolerance the removed dropdown label had).
function ariaSortFor(
  base: string,
  sortOption: string,
): "ascending" | "descending" | "none" {
  const activeBase = sortOption.replace(" desc", "");
  if (base !== activeBase) return "none";
  return sortOption.endsWith(" desc") ? "descending" : "ascending";
}

// Blue circular directional indicator shown on the active sort column
// (Google Drive pattern: small brand-blue disc, contrasting arrow). Artwork
// mirrors TrashItemsContent's SortIndicator verbatim — the two headers are
// one visual language (arrow-up is lucide's, ISC; disc reuses the row's
// brand-primary token).
function SortIndicator({ desc }: { desc: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="flex w-[22px] h-[22px] shrink-0 items-center justify-center rounded-full bg-brand-primary text-white"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={desc ? "rotate-180" : ""}
      >
        <path d="m5 12 7-7 7 7" />
        <path d="M12 19V5" />
      </svg>
    </span>
  );
}

// Sortable column header for the My Drive list, mirroring the Trash screen's
// sticky header (TrashItemsContent.tsx): same column classes, same
// aria-sort-on-wrapper semantics, same blue-disc indicator. Presentational
// only — sort state stays in driveStore; clicks flow through the existing
// onSortChange chain.
//
// NOTE: changing the sort clears selection and resets the page (the existing
// useDriveExplorer contract) — an accepted inheritance, documented here so it
// is not mistaken for a header-specific regression.
export function FileListHeader({
  sortOption,
  onSortChange,
}: FileListHeaderProps) {
  const { t } = useTranslation();

  const toggle = (base: string): void => {
    if (!onSortChange) return;
    if (sortOption.replace(" desc", "") === base) {
      // Active column: toggle direction (strip/append the " desc" suffix).
      onSortChange(
        sortOption.endsWith(" desc")
          ? sortOption.replace(" desc", "")
          : `${sortOption} desc`,
      );
      return;
    }
    // Inactive column: apply that column's default direction. Size defaults
    // to desc (largest first) like Trash and Google Drive. This header is now
    // the single sorting entry point for My Drive (the toolbar dropdown was
    // removed), so "size desc" is the one and only first-click behavior.
    onSortChange(base === "name" ? "name" : `${base} desc`);
  };

  return (
    <div
      role="presentation"
      className={`mt-2.5 flex items-center ${LIST_GAP} ${LIST_HEADER_PADDING}`}
    >
      {/* One shared column grid (listColumnLayout.ts) drives this header and
          the SongCard rows, so every label sits pixel-exactly above its
          values — change a track there and both sides move together. */}
      <span className={`${LIST_ICON_TRACK} shrink-0`} aria-hidden="true" />
      <span
        role="columnheader"
        aria-sort={ariaSortFor("name", sortOption)}
        className="flex-1 min-w-0 flex"
      >
        <button
          type="button"
          onClick={() => {
            toggle("name");
          }}
          className="flex-1 min-w-0 flex items-center gap-1 truncate text-left text-[15px] font-semibold text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors cursor-pointer"
        >
          <span className="truncate">{t("drive.col_name")}</span>
          {sortOption.replace(" desc", "") === "name" && (
            <SortIndicator desc={sortOption.endsWith(" desc")} />
          )}
        </button>
      </span>
      <span
        role="columnheader"
        aria-sort={ariaSortFor("modifiedTime", sortOption)}
        className={LIST_DATE_TRACK}
      >
        <button
          type="button"
          onClick={() => {
            toggle("modifiedTime");
          }}
          className="flex w-full items-center gap-1 text-left text-[15px] font-semibold text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors cursor-pointer"
        >
          <span className="truncate">{t("drive.col_date_modified")}</span>
          {sortOption.replace(" desc", "") === "modifiedTime" && (
            <SortIndicator desc={sortOption.endsWith(" desc")} />
          )}
        </button>
      </span>
      <span
        role="columnheader"
        aria-sort={ariaSortFor("size", sortOption)}
        className={LIST_SIZE_TRACK}
      >
        <button
          type="button"
          onClick={() => {
            toggle("size");
          }}
          className="flex w-full items-center justify-end gap-1 text-right text-[15px] font-semibold text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors cursor-pointer"
        >
          <span className="truncate">{t("drive.col_size")}</span>
          {sortOption.replace(" desc", "") === "size" && (
            <SortIndicator desc={sortOption.endsWith(" desc")} />
          )}
        </button>
      </span>
      {/* Same fixed actions track as the row's MoreMenu box, so Size's right
          edge lines up on both sides. */}
      <span className={`${LIST_ACTIONS_TRACK} shrink-0`} aria-hidden="true" />
    </div>
  );
}
