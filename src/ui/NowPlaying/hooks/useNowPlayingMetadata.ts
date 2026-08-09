import { useCallback, useEffect, useRef, useState } from "react";
import type { Track } from "../../../App";
import type { CachedMetadata } from "../../../utils/metadata";
import { getPalette } from "../../../utils/color";
import { captureError } from "../../../utils/errorLog";
import { useTrackMetadata } from "../../../hooks/useTrackMetadata";

const NOW_PLAYING_MODULE = "useNowPlayingMetadata";

/**
 * NowPlaying-specific adapter over the shared useTrackMetadata lifecycle:
 * adds the palette extraction (bgColor/bgPalette) and keeps the view-facing
 * API (coverUrl + setCoverUrl + realTitle/realArtist + colors).
 */
export function useNowPlayingMetadata(
  currentTrack: Track | null,
  token: string | null,
) {
  const [realTitle, setRealTitle] = useState("");
  const [realArtist, setRealArtist] = useState("");
  const [bgColor, setBgColor] = useState<string>("");
  const [bgPalette, setBgPalette] = useState<string[]>([]);

  const trackId = currentTrack?.id;
  const trackSize = currentTrack?.size;
  const trackOriginalName = currentTrack?.originalName;
  const trackStreamUrl = currentTrack?.streamUrl;

  const onMetadata = useCallback(
    (
      metadata: CachedMetadata,
      coverUrl: string | null,
      signal: AbortSignal,
    ) => {
      if (metadata.title) setRealTitle(metadata.title);
      if (metadata.artist) setRealArtist(metadata.artist);

      if (coverUrl) {
        // The blob is same-origin, so the canvas read inside getPalette is
        // untainted and no color.ts change is needed. The signal guards the
        // await: a track switch/unmount aborts and drops the stale palette.
        void (async () => {
          try {
            const colors = await getPalette(coverUrl);
            if (signal.aborted) return;
            const firstColor = colors[0];
            if (firstColor !== undefined) setBgColor(firstColor);
            setBgPalette(colors);
          } catch (err) {
            // A failed palette must not leave the previous track's colors
            // behind; the abort-check keeps the setState off an unmounted tree.
            if (!signal.aborted) {
              setBgColor("");
              setBgPalette([]);
            }
            void captureError({
              level: "warn",
              source: NOW_PLAYING_MODULE,
              message: `palette-failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            });
          }
        })();
      } else {
        setBgColor("");
        setBgPalette([]);
      }
    },
    [],
  );

  const onError = useCallback((error: unknown) => {
    void captureError({
      level: "error",
      source: NOW_PLAYING_MODULE,
      message: `track-metadata-failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
    // resetPalette equivalent: the hook only reports non-abort failures, so
    // the tree is still mounted and the colors can be cleared safely.
    setBgColor("");
    setBgPalette([]);
  }, []);

  const onCleanup = useCallback(() => {
    setBgColor("");
    setBgPalette([]);
  }, []);

  const { coverUrl, setCoverUrl } = useTrackMetadata({
    fileId: trackId ?? null,
    token,
    size: trackSize,
    originalName: trackOriginalName,
    enabled: !!trackId,
    // streamUrl is not part of the fetch args but a streamUrl change must
    // re-fetch (session-restore refreshes the URL for the same track id).
    refreshKey: trackStreamUrl,
    onMetadata,
    onError,
    onCleanup,
  });

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

  // Unmount-only palette reset — track changes are already handled by the
  // adjust-during-render reset above; this effect exists so the transient
  // colors are cleared even when the view unmounts mid-palette-decode.
  useEffect(() => {
    return () => {
      setBgColor("");
      setBgPalette([]);
    };
  }, []);

  return { coverUrl, setCoverUrl, realTitle, realArtist, bgColor, bgPalette };
}
