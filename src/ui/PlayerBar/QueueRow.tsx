import { Check } from "lucide-react";
import type { Track } from "../../types";
import { MoreMenu } from "../components/MoreMenu";

// Fixed row height: the virtualizer (QueueList) uses it as the exact estimate
// (no measureElement round-trips) and the row style pins it, so offsets can
// never drift from the rendered height. 56 = 2 lines (text-sm 20 + text-xs 16)
// + py-2.5 (10+10).
export const QUEUE_ROW_HEIGHT = 56;

export interface QueueRowProps {
  track: Track;
  isCurrent: boolean;
  isChecked: boolean;
  selectionMode: boolean;
  onActivate: () => void;
  onToggleSelected: () => void;
  onRemoveFromQueue: () => void;
  onRemoveFolderFromQueue?: (() => void) | undefined;
}

function QueueRowCheckbox({
  checked,
  label,
  onToggle,
}: {
  checked: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <span className="relative inline-flex shrink-0">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        onClick={(e) => {
          // The row's click is a separate activation — a checkbox click must
          // only toggle the checkbox, never also select the row.
          e.stopPropagation();
        }}
        aria-label={label}
        className="peer appearance-none w-4 h-4 rounded border-2 border-gray-400 dark:border-gray-500 bg-white dark:bg-[#2a2b2f] checked:bg-brand-primary checked:border-brand-primary cursor-pointer transition-colors"
      />
      <Check
        className="absolute inset-0 m-auto w-3 h-3 text-white opacity-0 peer-checked:opacity-100 pointer-events-none"
        strokeWidth={3}
      />
    </span>
  );
}

/**
 * One queue entry: title/artist, optional selection checkbox, per-row menu.
 * The playing row is not a control (aria-current, no select/removal) — plain
 * presentational markup; every other row is a keyboard-operable button.
 */
export function QueueRow({
  track,
  isCurrent,
  isChecked,
  selectionMode,
  onActivate,
  onToggleSelected,
  onRemoveFromQueue,
  onRemoveFolderFromQueue,
}: QueueRowProps) {
  const rowClass = `flex items-center gap-3 px-2 py-2.5 rounded-xl transition-colors ${
    isCurrent
      ? "bg-brand-primary/10 text-brand-primary cursor-default"
      : "cursor-pointer hover:bg-gray-100 dark:hover:bg-[#2a2b2f]"
  }`;

  const content = (
    <>
      {selectionMode && !isCurrent && (
        <QueueRowCheckbox
          checked={isChecked}
          label={track.title}
          onToggle={onToggleSelected}
        />
      )}

      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{track.title}</div>
        <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
          {track.artist}
        </div>
      </div>

      {!selectionMode && (
        <MoreMenu
          variant="queue"
          track={track}
          disableRemoveFromQueue={isCurrent}
          onRemoveFromQueue={onRemoveFromQueue}
          onRemoveFolderFromQueue={onRemoveFolderFromQueue}
        />
      )}
    </>
  );

  if (isCurrent) {
    return (
      <div
        data-testid="queue-row"
        aria-current="true"
        className={rowClass}
        style={{ height: QUEUE_ROW_HEIGHT }}
      >
        {content}
      </div>
    );
  }

  return (
    <div
      data-testid="queue-row"
      role="button"
      tabIndex={0}
      onClick={onActivate}
      onKeyDown={(e) => {
        // Keys pressed inside the row menu must not activate the row.
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate();
        }
      }}
      className={rowClass}
      style={{ height: QUEUE_ROW_HEIGHT }}
    >
      {content}
    </div>
  );
}
