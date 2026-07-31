import { useState, useEffect } from "react";
import { Track } from "../../../App";
import { getTrackMetadata } from "../../../utils/metadata";
import { getPalette } from '../../../utils/color';

function classifyNowPlayingError(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: "UnknownError", message: String(err) };
}

export function useNowPlayingMetadata(currentTrack: Track | null, token: string | null) {
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [realTitle, setRealTitle] = useState("");
  const [realArtist, setRealArtist] = useState("");
  const [bgColor, setBgColor] = useState<string>('');
  const [bgPalette, setBgPalette] = useState<string[]>([]);

  useEffect(() => {
    if (currentTrack) {
      setRealTitle(currentTrack.title);
      setRealArtist(currentTrack.artist || "");
      setCoverUrl(null);
      
      let isCancelled = false;
      let objectUrl: string | null = null;
      const controller = new AbortController();

      const revokeCoverUrl = () => {
        if (objectUrl) {
          URL.revokeObjectURL(objectUrl);
          objectUrl = null;
        }
      };

      getTrackMetadata(currentTrack.id, token || undefined, currentTrack.size, currentTrack.originalName, controller.signal)
        .then(metadata => {
          if (isCancelled) return;
          if (metadata.title) setRealTitle(metadata.title);
          if (metadata.artist) setRealArtist(metadata.artist);
          
          const targetCover = metadata.fullCoverUrl || metadata.coverUrl;
          if (targetCover) {
            setCoverUrl(targetCover);
            getPalette(targetCover)
              .then(colors => {
                if (isCancelled) return;
                setBgColor(colors[0]);
                setBgPalette(colors);
              })
              .catch((err) => {
                if (!isCancelled) {
                  setBgColor('');
                  setBgPalette([]);
                }
                console.warn('[NowPlaying] palette-failed', { trackId: currentTrack?.id, err: classifyNowPlayingError(err) });
              });
          } else if ((metadata.pictureDataFull || metadata.pictureData) && metadata.pictureFormat) {
            const data = metadata.pictureDataFull || metadata.pictureData;
            const blob = new Blob([new Uint8Array(data!)], { type: metadata.pictureFormat });
            const coverObjectUrl = URL.createObjectURL(blob);
            objectUrl = coverObjectUrl;
            setCoverUrl(coverObjectUrl);

            Promise.resolve()
              .then(() => getPalette(coverObjectUrl))
              .then(colors => {
                if (isCancelled) return;
                setBgColor(colors[0]);
                setBgPalette(colors);
              })
              .catch((err) => {
                if (!isCancelled) {
                  setBgColor('');
                  setBgPalette([]);
                }
                console.warn('[NowPlaying] palette-failed', { trackId: currentTrack?.id, err: classifyNowPlayingError(err) });
              })
              .finally(() => revokeCoverUrl());
          } else {
            setBgColor('');
            setBgPalette([]);
          }
        })
        .catch((e) => {
          console.error('[NowPlaying] track-metadata-failed', { trackId: currentTrack?.id, ...classifyNowPlayingError(e) });
          if (!isCancelled) {
            setBgColor('');
            setBgPalette([]);
          }
        });
        
      return () => {
        isCancelled = true;
        controller.abort();
        setBgColor('');
        setBgPalette([]);
      };
    } else {
      setBgColor('');
      setBgPalette([]);
    }
  }, [currentTrack?.id, currentTrack?.streamUrl, token]);

  return { coverUrl, setCoverUrl, realTitle, realArtist, bgColor, bgPalette };
}
