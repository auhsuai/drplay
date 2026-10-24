import { Repeat, Repeat1, Shuffle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PlayMode, Track } from "../../types";

export interface PlayModeButtonProps {
  currentTrack: Track | null;
  playMode: PlayMode;
  onTogglePlayMode: () => void;
}

export function PlayModeButton({
  currentTrack,
  playMode,
  onTogglePlayMode,
}: PlayModeButtonProps) {
  const { t } = useTranslation();

  return (
    <div className="relative group flex items-center shrink-0">
      <button
        onClick={onTogglePlayMode}
        aria-label={t("player.play_mode")}
        className={`p-2 rounded-full transition-all active:scale-[0.92] disabled:opacity-50 disabled:hover:bg-transparent shrink-0 ${playMode !== "normal" ? "text-brand-text hover:bg-brand-primary/10" : "text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-[#2a2b2f]"}`}
        disabled={!currentTrack}
      >
        {playMode === "shuffle" && <Shuffle className="w-6 h-6" />}
        {playMode === "repeat-all" && <Repeat className="w-6 h-6" />}
        {playMode === "repeat-one" && <Repeat1 className="w-6 h-6" />}
        {playMode === "normal" && <Repeat className="w-6 h-6" />}
      </button>
    </div>
  );
}
