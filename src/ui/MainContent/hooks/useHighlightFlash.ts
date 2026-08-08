import React, { useState } from "react";

// Fixed chrome bands the card must stay within to count as "fully visible"
// (below the main header, above the player bar).
const HEADER_HEIGHT = 160;
const PLAYER_BAR_HEIGHT = 85;
// One on→off cycle for the navigate/locate highlight cue. The old
// implementation toggled isFlashOn 7× every 300ms (≈4 blinks) which looked broken.
const FLASH_DURATION_MS = 400;
// Accent tint for "selected (bulk mode)" cards. Playing cards deliberately do
// NOT use it: the user design wants the now-playing card to look exactly like
// the hovered idle card (gray bg + blue title/icon + soft shadow) but WITHOUT
// the hover lift, so it shares the idle hover palette instead of the accent.
export const ACCENT_CARD_TINT = "bg-[#4285F4]/10 dark:bg-[#4285F4]/20";
export const ACCENT_CARD_TINT_HOVER =
  "hover:bg-[#4285F4]/20 dark:hover:bg-[#4285F4]/30";

export function useHighlightFlash({
  isHighlighted,
  highlightTrigger,
  cardRef,
}: {
  isHighlighted?: boolean | undefined;
  highlightTrigger?: number | undefined;
  cardRef: React.RefObject<HTMLDivElement | null>;
}): boolean {
  const [isFlashOn, setIsFlashOn] = useState(false);

  React.useEffect(() => {
    if (isHighlighted && cardRef.current) {
      const rect = cardRef.current.getBoundingClientRect();
      const isVisible =
        rect.top >= HEADER_HEIGHT &&
        rect.bottom <= window.innerHeight - PLAYER_BAR_HEIGHT;

      if (!isVisible) {
        cardRef.current.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      }

      // Single flash: one on→off cycle is the intended "located" cue. The old
      // implementation toggled isFlashOn 7× @ 300ms (≈4 blinks) which looked broken.
      setIsFlashOn(true);
      const timer = setTimeout(() => {
        setIsFlashOn(false);
      }, FLASH_DURATION_MS);
      return () => {
        clearTimeout(timer);
        setIsFlashOn(false);
      };
    }
  }, [isHighlighted, highlightTrigger]);

  return isFlashOn;
}
