import { Repeat, Repeat1, Shuffle, SquareCheckBig } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PlayMode } from "../../types";

const MODE_ORDER: PlayMode[] = [
  "normal",
  "shuffle",
  "repeat-all",
  "repeat-one",
];

// Literal key union: i18next's typed `t` only accepts known resource keys.
const MODE_LABEL_KEYS = {
  normal: "queue.mode_normal",
  shuffle: "queue.mode_shuffle",
  "repeat-all": "queue.mode_repeat_all",
  "repeat-one": "queue.mode_repeat_one",
} as const satisfies Record<PlayMode, string>;

// Same icon language as TransportControls: plain Repeat (dimmed) for normal.
const MODE_ICONS: Record<PlayMode, LucideIcon> = {
  normal: Repeat,
  shuffle: Shuffle,
  "repeat-all": Repeat,
  "repeat-one": Repeat1,
};

const ACTIVE_CLASS = "text-brand-primary bg-brand-primary/10";
const IDLE_CLASS =
  "text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#2a2b2f]";

export interface QueueControlsProps {
  playMode: PlayMode;
  onSetPlayMode: (mode: PlayMode) => void;
  selectionMode: boolean;
  onToggleSelectionMode: () => void;
}

/** Play-mode switch (4 modes) + multi-select toggle. */
export function QueueControls({
  playMode,
  onSetPlayMode,
  selectionMode,
  onToggleSelectionMode,
}: QueueControlsProps) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-1">
        {MODE_ORDER.map((mode) => {
          const Icon = MODE_ICONS[mode];
          const isActive = playMode === mode;
          return (
            <button
              key={mode}
              type="button"
              onClick={() => {
                onSetPlayMode(mode);
              }}
              aria-pressed={isActive}
              aria-label={t(MODE_LABEL_KEYS[mode])}
              title={t(MODE_LABEL_KEYS[mode])}
              className={`p-2 rounded-full transition-all active:scale-[0.92] ${
                isActive ? ACTIVE_CLASS : IDLE_CLASS
              }`}
            >
              <Icon
                className={`w-5 h-5 ${mode === "normal" ? "opacity-40" : ""}`}
              />
            </button>
          );
        })}
      </div>

      <button
        type="button"
        onClick={onToggleSelectionMode}
        aria-pressed={selectionMode}
        aria-label={t("queue.select_multiple")}
        title={t("queue.select_multiple")}
        className={`p-2 rounded-full transition-all active:scale-[0.92] ${
          selectionMode ? ACTIVE_CLASS : IDLE_CLASS
        }`}
      >
        <SquareCheckBig className="w-5 h-5" />
      </button>
    </div>
  );
}
