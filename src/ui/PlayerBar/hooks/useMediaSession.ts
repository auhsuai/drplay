import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { Track } from "../../../App";

export function useMediaSession(
  currentTrack: Track | null,
  onTogglePlayRef: React.MutableRefObject<() => void>,
  onPrevTrackRef: React.MutableRefObject<() => void>,
  onNextTrackRef: React.MutableRefObject<() => void>,
) {
  const { t } = useTranslation();
  useEffect(() => {
    if ("mediaSession" in navigator && currentTrack) {
      const artwork: MediaImage[] = [
        { src: "/sample.png", sizes: "512x512", type: "image/png" },
      ];

      navigator.mediaSession.metadata = new MediaMetadata({
        title:
          currentTrack.title ||
          currentTrack.originalName ||
          t("song_card.unknown_title", "Unknown Title"),
        artist: currentTrack.artist || "DrPlay",
        artwork,
      });

      navigator.mediaSession.setActionHandler("play", () => {
        onTogglePlayRef.current();
      });
      navigator.mediaSession.setActionHandler("pause", () => {
        onTogglePlayRef.current();
      });
      navigator.mediaSession.setActionHandler("previoustrack", () => {
        onPrevTrackRef.current();
      });
      navigator.mediaSession.setActionHandler("nexttrack", () => {
        onNextTrackRef.current();
      });
    }

    return () => {
      if ("mediaSession" in navigator) {
        navigator.mediaSession.setActionHandler("play", null);
        navigator.mediaSession.setActionHandler("pause", null);
        navigator.mediaSession.setActionHandler("previoustrack", null);
        navigator.mediaSession.setActionHandler("nexttrack", null);
      }
    };
  }, [currentTrack, onTogglePlayRef, onPrevTrackRef, onNextTrackRef, t]);
}
