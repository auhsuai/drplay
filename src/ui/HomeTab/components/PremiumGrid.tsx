import type { Track } from "../../../types";
import { PremiumCard } from "./PremiumCard";

const PREMIUM_GRID_CLASS =
  "grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-6";

export function PremiumGrid({
  items,
  onPlay,
  token,
  isOverlay,
  onOverlayClick,
  className = PREMIUM_GRID_CLASS,
}: {
  items: Track[];
  onPlay: (track: Track, contextQueue?: Track[]) => void;
  token: string | null;
  isOverlay?: (track: Track, index: number) => boolean;
  onOverlayClick?: () => void;
  className?: string;
}) {
  return (
    <div className={className}>
      {items.map((track, index) => {
        const isOverlayCard = isOverlay ? isOverlay(track, index) : false;
        return (
          <PremiumCard
            key={track.id}
            track={track}
            onPlay={() => {
              if (isOverlayCard && onOverlayClick) {
                onOverlayClick();
              } else {
                onPlay(track, items);
              }
            }}
            token={token}
            isOverlayBtn={isOverlayCard}
          />
        );
      })}
    </div>
  );
}
