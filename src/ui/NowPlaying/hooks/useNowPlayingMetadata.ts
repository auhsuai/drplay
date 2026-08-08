import { useState, useEffect, useRef } from "react";
import type { Track } from "../../../App";
import { getTrackMetadata } from "../../../utils/metadata";
import { buildCoverBlobUrl, buildCoverUrl } from "../../../utils/coverStore";
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
    const controller = new AbortController();

    // Closure guard helper: the abort flag is only ever written by the effect
    // cleanup, so TypeScript's CFA narrows the captured `let` to `false`
    // inside the async IIFE — a plain `if (cancelled)` would be a lint
    // false positive. Reading through a closure function defeats the
    // narrowing while staying semantically identical.
    const isCancelled = () => cancelled;

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

        // S4: covers render from the Rust disk cache via drplay:// — no blob
        // URL is kept in RAM. Full variant preferred (thumb=false); thumb
        // fallback; null when the track has no picture (icon stays).
        // getPalette decodes via new Image() + canvas: the drplay:// GET
        // carries Access-Control-Allow-Origin: * (protocol/mod.rs), so the
        // canvas read is not tainted and no color.ts change is needed.
        const coverUrl = metadata.pictureDataFull
          ? buildCoverUrl(trackId, false)
          : metadata.pictureData
            ? buildCoverUrl(trackId, true)
            : null;
        if (coverUrl) {
          setCoverUrl(coverUrl);
          // Fix G: drplay:// only resolves inside the Tauri WebView. In a dev
          // browser the scheme is blocked (ERR_UNKNOWN_URL_SCHEME) and both
          // the <img> and the palette decode fail. Re-decode from a blob URL
          // built with the exact bytes metadata already parsed — same-origin,
          // so the canvas read is untainted. One attempt only: a blob decode
          // failure means the bytes are bad, so fall through to the icon.
          const fallbackBytes =
            metadata.pictureDataFull ?? metadata.pictureData;
          const fallbackFormat = metadata.pictureFormat;
          try {
            const colors = await getPalette(coverUrl);
            if (isCancelled()) return;
            const firstColor = colors[0];
            if (firstColor !== undefined) setBgColor(firstColor);
            setBgPalette(colors);
          } catch (err) {
            const blobUrl = buildCoverBlobUrl(fallbackBytes, fallbackFormat);
            if (blobUrl) {
              if (isCancelled()) return;
              setCoverUrl(blobUrl);
              try {
                const colors = await getPalette(blobUrl);
                if (isCancelled()) return;
                const firstColor = colors[0];
                if (firstColor !== undefined) setBgColor(firstColor);
                setBgPalette(colors);
              } catch (err2) {
                resetPalette();
                void captureError({
                  level: "warn",
                  source: NOW_PLAYING_MODULE,
                  message: `palette-failed (drplay:// + blob fallback): ${
                    err2 instanceof Error ? err2.message : String(err2)
                  }`,
                });
              }
            } else {
              resetPalette();
              void captureError({
                level: "warn",
                source: NOW_PLAYING_MODULE,
                message: `palette-failed: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              });
            }
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
