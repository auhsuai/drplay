import { useState, useEffect, useRef } from "react";
import type { Track } from "../../../App";
import { getTrackMetadata } from "../../../utils/metadata";
import { getPalette } from "../../../utils/color";
import { captureError } from "../../../utils/errorLog";

const NOW_PLAYING_MODULE = "useNowPlayingMetadata";

export function useNowPlayingMetadata(
  currentTrack: Track | null,
  token: string | null,
) {
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [realTitle, setRealTitle] = useState("");
  const [realArtist, setRealArtist] = useState("");
  const [bgColor, setBgColor] = useState<string>("");
  const [bgPalette, setBgPalette] = useState<string[]>([]);

  const trackId = currentTrack?.id;
  const trackSize = currentTrack?.size;
  const trackOriginalName = currentTrack?.originalName;
  const trackStreamUrl = currentTrack?.streamUrl;

  // Reset transient state during render (React 19 "adjusting state when props
  // change" pattern) instead of synchronously inside the effect
  // (react-hooks/set-state-in-effect): a new track must clear the previous
  // title/artist/cover before the metadata fetch re-populates them.
  const prevTrackIdRef = useRef<string | undefined>(undefined);
  if (trackId !== prevTrackIdRef.current) {
    prevTrackIdRef.current = trackId;
    setRealTitle(currentTrack?.title ?? "");
    setRealArtist(currentTrack?.artist ?? "");
    setCoverUrl(null);
    setBgColor("");
    setBgPalette([]);
  }

  useEffect(() => {
    if (!trackId) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    const controller = new AbortController();

    // Closure guard helper: the abort flag is only ever written by the effect
    // cleanup, so TypeScript's CFA narrows the captured `let` to `false`
    // inside the async IIFE — a plain `if (cancelled)` would be a lint
    // false positive. Reading through a closure function defeats the
    // narrowing while staying semantically identical.
    const isCancelled = () => cancelled;

    const revokeCoverUrl = () => {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
        objectUrl = null;
      }
    };

    const resetPalette = () => {
      if (!isCancelled()) {
        setBgColor("");
        setBgPalette([]);
      }
    };

    void (async () => {
      try {
        const metadata = await getTrackMetadata(
          trackId,
          token || undefined,
          trackSize,
          trackOriginalName,
          controller.signal,
        );
        if (isCancelled()) return;
        if (metadata.title) setRealTitle(metadata.title);
        if (metadata.artist) setRealArtist(metadata.artist);

        const picture = metadata.pictureDataFull ?? metadata.pictureData;
        if (picture && metadata.pictureFormat) {
          const blob = new Blob([new Uint8Array(picture)], {
            type: metadata.pictureFormat,
          });
          const coverObjectUrl = URL.createObjectURL(blob);
          objectUrl = coverObjectUrl;
          setCoverUrl(coverObjectUrl);

          try {
            const colors = await getPalette(coverObjectUrl);
            if (isCancelled()) return;
            setBgColor(colors[0]);
            setBgPalette(colors);
          } catch (err) {
            resetPalette();
            void captureError({
              level: "warn",
              source: NOW_PLAYING_MODULE,
              message: `palette-failed: ${err instanceof Error ? err.message : String(err)}`,
            });
          } finally {
            revokeCoverUrl();
          }
        } else {
          setBgColor("");
          setBgPalette([]);
        }
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        void captureError({
          level: "error",
          source: NOW_PLAYING_MODULE,
          message: `track-metadata-failed: ${e instanceof Error ? e.message : String(e)}`,
        });
        resetPalette();
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      setBgColor("");
      setBgPalette([]);
    };
  }, [trackId, trackSize, trackOriginalName, trackStreamUrl, token]);

  return { coverUrl, setCoverUrl, realTitle, realArtist, bgColor, bgPalette };
}
