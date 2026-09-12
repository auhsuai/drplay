import { useCallback, useEffect, useRef, useState } from "react";
import type { Track } from "../../../types";
import type { CachedMetadata } from "../../../utils/metadata";
import type { PaletteMode } from "../../../utils/color";
import { getPalette } from "../../../utils/color";
import { captureError } from "../../../utils/errorLog";
import { useTrackMetadata } from "../../../hooks/useTrackMetadata";

const NOW_PLAYING_MODULE = "useNowPlayingMetadata";

// The theme class on <html> is the single source of truth (useTheme.ts); no
// class means the jsdom/test default and is treated as dark (back-compat).
function readPaletteMode(): PaletteMode {
  return document.documentElement.classList.contains("light")
    ? "light"
    : "dark";
}

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

  // The palette is theme-dependent, so the mode is read from <html>'s class
  // (the single source of truth) at palette-request time.
  const paletteModeRef = useRef<PaletteMode>(readPaletteMode());
  // Cover whose palette is currently loaded/loading — the theme observer
  // reloads the palette for this cover when the mode flips.
  const paletteCoverUrlRef = useRef<string | null>(null);
  // Monotonic request id: only the newest palette request may write state
  // (drops stale results after a track switch or a rapid theme toggle).
  const paletteRequestIdRef = useRef(0);

  const loadPalette = useCallback(
    (coverUrl: string, signal: AbortSignal | null) => {
      paletteCoverUrlRef.current = coverUrl;
      const requestId = ++paletteRequestIdRef.current;
      void (async () => {
        try {
          const colors = await getPalette(coverUrl, paletteModeRef.current);
          if (signal?.aborted || requestId !== paletteRequestIdRef.current) {
            return;
          }
          const firstColor = colors[0];
          if (firstColor !== undefined) setBgColor(firstColor);
          setBgPalette(colors);
        } catch (err) {
          // A failed palette must not leave the previous track's colors
          // behind; the abort/request guards keep the setState off a stale
          // or unmounted tree.
          if (!signal?.aborted && requestId === paletteRequestIdRef.current) {
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
    },
    [],
  );

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
        loadPalette(coverUrl, signal);
      } else {
        paletteCoverUrlRef.current = null;
        paletteRequestIdRef.current++;
        setBgColor("");
        setBgPalette([]);
      }
    },
    [loadPalette],
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
    paletteCoverUrlRef.current = null;
    // Invalidate any in-flight palette (a theme reload has no metadata signal
    // to abort it, so the request id is its only guard).
    paletteRequestIdRef.current++;
    setBgColor("");
    setBgPalette([]);
  }, []);

  // Live theme switch: when useTheme() flips the class on <html> while a
  // cover is loaded, recompute the palette for the new mode without waiting
  // for a track change. Cleanup disconnects the observer on unmount.
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const nextMode = readPaletteMode();
      if (nextMode === paletteModeRef.current) return;
      paletteModeRef.current = nextMode;
      const cover = paletteCoverUrlRef.current;
      if (cover !== null) loadPalette(cover, null);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => {
      observer.disconnect();
    };
  }, [loadPalette]);

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
