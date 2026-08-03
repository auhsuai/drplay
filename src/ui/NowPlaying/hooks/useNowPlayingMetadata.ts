import { useState, useEffect } from "react";
import { Track } from "../../../App";
import { getTrackMetadata } from "../../../utils/metadata";
import { getPalette } from '../../../utils/color';
import { captureError } from "../../../utils/errorLog";

const NOW_PLAYING_MODULE = 'useNowPlayingMetadata';

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

      const resetPalette = () => {
        if (!isCancelled) {
          setBgColor('');
          setBgPalette([]);
        }
      };

      void (async () => {
        try {
          const metadata = await getTrackMetadata(currentTrack.id, token || undefined, currentTrack.size, currentTrack.originalName, controller.signal);
          if (isCancelled) return;
          if (metadata.title) setRealTitle(metadata.title);
          if (metadata.artist) setRealArtist(metadata.artist);

          const picture = metadata.pictureDataFull ?? metadata.pictureData;
          if (picture && metadata.pictureFormat) {
            const blob = new Blob([new Uint8Array(picture)], { type: metadata.pictureFormat });
            const coverObjectUrl = URL.createObjectURL(blob);
            objectUrl = coverObjectUrl;
            setCoverUrl(coverObjectUrl);

            try {
              const colors = await getPalette(coverObjectUrl);
              if (isCancelled) return;
              setBgColor(colors[0]);
              setBgPalette(colors);
            } catch (err) {
              resetPalette();
              captureError({ level: 'warn', source: NOW_PLAYING_MODULE, message: `palette-failed: ${err instanceof Error ? err.message : String(err)}` });
            } finally {
              revokeCoverUrl();
            }
          } else {
            setBgColor('');
            setBgPalette([]);
          }
        } catch (e) {
          if (e instanceof DOMException && e.name === 'AbortError') return;
          captureError({ level: 'error', source: NOW_PLAYING_MODULE, message: `track-metadata-failed: ${e instanceof Error ? e.message : String(e)}` });
          resetPalette();
        }
      })();
        
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
