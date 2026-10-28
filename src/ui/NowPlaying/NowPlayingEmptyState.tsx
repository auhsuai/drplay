import { ChevronDown, Music } from "lucide-react";
import { useTranslation } from "react-i18next";

interface NowPlayingEmptyStateProps {
  onBack: () => void;
}

export function NowPlayingEmptyState({ onBack }: NowPlayingEmptyStateProps) {
  const { t } = useTranslation();

  return (
    // No media at all is still "no usable frame", so this surface is solid
    // opaque black: an empty player must not let anything show through the
    // composition transparency.
    <main className="flex-1 bg-black overflow-hidden flex flex-col items-center justify-center relative">
      <button
        onClick={onBack}
        aria-label={t("common.close")}
        className="absolute top-8 left-8 p-2 text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors active:scale-95 z-50"
      >
        <ChevronDown className="w-6 h-6" />
      </button>
      <div className="w-48 h-48 rounded-2xl bg-gradient-to-br from-brand-primary/10 to-[#34A853]/10 flex items-center justify-center mb-6">
        <Music className="w-24 h-24 text-brand-text/40 dark:text-[#34A853]/50 drop-shadow-sm" />
      </div>
      <h2 className="text-xl font-bold text-gray-500 dark:text-gray-400">
        {t("player.no_track")}
      </h2>
    </main>
  );
}
