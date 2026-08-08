import type { IAudioMetadata } from "music-metadata";
import { captureError } from "../errorLog";
import {
  compressCoverImage,
  isImageTruncated,
  COVER_MAX_BYTES,
  FULL_MAX_SIZE,
  FULL_QUALITY,
  THUMB_MAX_SIZE,
  THUMB_QUALITY,
} from "../coverCompress";
import { postCoverToCache } from "../coverStore";
import { classifyMetaError, setFullPictureCache } from "./cache";
import { JPEG_MIME, META_MODULE } from "./constants";
import type { CachedMetadata } from "./types";

/**
 * 3b. Cover: compress the embedded picture into a persisted thumb (≤256px)
 * and a full variant (≤2000px; memory LRU + IDB-persisted when JPEG).
 * A failing picture NEVER drops the text entry — every branch below warns and
 * skips, leaving entry v:8 fully populated. Mutates `entry` (pictureData /
 * pictureFormat / pictureDataFull) exactly as the original inline block did.
 */
export async function processCovers(
  fileId: string,
  entry: CachedMetadata,
  pictures: IAudioMetadata["common"]["picture"],
): Promise<void> {
  if (pictures && pictures.length > 0) {
    const pic = pictures[0];
    if (pic) {
      if (pic.data.byteLength > COVER_MAX_BYTES) {
        await captureError({
          level: "warn",
          source: META_MODULE,
          message: `cover-skip-too-large (fileId=${fileId}, bytes=${String(pic.data.byteLength)})`,
          kind: "CoverTooLarge",
        });
      } else if (isImageTruncated(pic.data)) {
        await captureError({
          level: "warn",
          source: META_MODULE,
          message: `cover-skip-truncated (fileId=${fileId}, format=${pic.format})`,
          kind: "CoverTruncated",
        });
      } else {
        try {
          const thumb = await compressCoverImage(
            pic.data,
            pic.format,
            THUMB_MAX_SIZE,
            THUMB_QUALITY,
          );
          entry.pictureData = thumb.data;
          entry.pictureFormat = thumb.format;
          if (thumb.format === JPEG_MIME) {
            // S4: push the compressed thumb to the Rust disk cache. The
            // protocol/cover.rs contract is JPEG-only — original PNG/WebP
            // bytes are never POSTed (and in WebView2 the drplay:// scheme
            // is dead anyway, so skip silently: no warn noise).
            // Fire-and-forget on purpose — postCoverToCache never rejects,
            // so the render hot path is never blocked by a disk hiccup
            // (non-fatal by design).
            void postCoverToCache(fileId, true, thumb.data);
          }
        } catch (e: unknown) {
          await captureError({
            level: "warn",
            source: META_MODULE,
            message: `cover-compress-failed (fileId=${fileId}, variant=thumb): ${classifyMetaError(e).message}`,
            kind: classifyMetaError(e).name,
          });
        }
        try {
          const full = await compressCoverImage(
            pic.data,
            pic.format,
            FULL_MAX_SIZE,
            FULL_QUALITY,
          );
          entry.pictureDataFull = full.data;
          setFullPictureCache(fileId, full.data);
          if (full.format === JPEG_MIME) {
            // S4: push the compressed full variant to the Rust disk cache too
            // (fire-and-forget, non-fatal — see the thumb POST above).
            // JPEG-only: an original PNG/WebP full is never POSTed.
            void postCoverToCache(fileId, false, full.data);
          }
        } catch (e: unknown) {
          await captureError({
            level: "warn",
            source: META_MODULE,
            message: `cover-compress-failed (fileId=${fileId}, variant=full): ${classifyMetaError(e).message}`,
            kind: classifyMetaError(e).name,
          });
        }
      }
    }
  }
}
