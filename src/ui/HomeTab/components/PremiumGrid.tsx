import type { Track } from "../../../types";
import { IS_MOBILE } from "../../../utils/platform";
import { PremiumCard } from "./PremiumCard";

const PREMIUM_GRID_CLASS =
  "grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-6";
// Task 7: mobile-only horizontal snap strip for sections WITHOUT a View All
// affordance — overflow-x-auto + snap-x, fixed-width snap-start cards so
// swiping picks a track fast. Desktop keeps the grid untouched.
const PREMIUM_SCROLL_CLASS = "flex overflow-x-auto snap-x snap-mandatory gap-4";
const PREMIUM_SCROLL_ITEM_CLASS = "shrink-0 snap-start w-40";

export function PremiumGrid({
  items,
  onPlay,
  token,
  isOverlay,
  onOverlayClick,
  className = PREMIUM_GRID_CLASS,
  scrollable = false,
}: {
  items: Track[];
  onPlay: (track: Track, contextQueue?: Track[]) => void;
  token: string | null;
  isOverlay?: (track: Track, index: number) => boolean;
  onOverlayClick?: () => void;
  className?: string;
  scrollable?: boolean;
}) {
  const containerClass =
    IS_MOBILE && scrollable ? PREMIUM_SCROLL_CLASS : className;
  return (
    <div className={containerClass}>
      {items.map((track, index) => {
        const isOverlayCard = isOverlay ? isOverlay(track, index) : false;
        const card = (
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
        // IS_MOBILE is a module constant per page load: the wrapper only ever
        // exists on mobile scroll strips — desktop DOM stays byte-identical.
        return IS_MOBILE && scrollable ? (
          <div key={track.id} className={PREMIUM_SCROLL_ITEM_CLASS}>
            {card}
          </div>
        ) : (
          card
        );
      })}
    </div>
  );
}
