import type { IAudioMetadata } from "music-metadata";
import { captureError } from "../errorLog";
import {
  compressCoverVariants,
  type CoverVariantResult,
  CoverEncodeError,
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
 * 3b. Cover: compress the embedded picture with ONE decode into two variants —
 * a persisted thumb (≤256px) and a full variant (≤2000px; memory LRU +
 * IDB-persisted when JPEG). A failing picture NEVER drops the text entry —
 * every branch below warns and skips, leaving entry v:8 fully populated.
 * Mutates `entry` (pictureData / pictureFormat / pictureDataFull) exactly as
 * the original inline block did.
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
          const outcomes = await compressCoverVariants(pic.data, pic.format, [
            { maxSize: THUMB_MAX_SIZE, quality: THUMB_QUALITY },
            { maxSize: FULL_MAX_SIZE, quality: FULL_QUALITY },
          ]);
          const thumbOutcome = requireOutcome(outcomes, 0);
          const fullOutcome = requireOutcome(outcomes, 1);
          if (thumbOutcome.ok) {
            entry.pictureData = thumbOutcome.result.data;
            entry.pictureFormat = thumbOutcome.result.format;
            if (thumbOutcome.result.format === JPEG_MIME) {
              // S4: push the compressed thumb to the Rust disk cache. The
              // protocol/cover.rs contract is JPEG-only — original PNG/WebP
              // bytes are never POSTed (and in WebView2 the drplay:// scheme
              // is dead anyway, so skip silently: no warn noise).
              // Fire-and-forget on purpose — postCoverToCache never rejects,
              // so the render hot path is never blocked by a disk hiccup
              // (non-fatal by design).
              void postCoverToCache(fileId, true, thumbOutcome.result.data);
            }
          } else {
            await captureError({
              level: "warn",
              source: META_MODULE,
              message: `cover-compress-failed (fileId=${fileId}, variant=thumb): ${classifyMetaError(thumbOutcome.error).message}`,
              kind: classifyMetaError(thumbOutcome.error).name,
            });
          }
          if (fullOutcome.ok) {
            entry.pictureDataFull = fullOutcome.result.data;
            setFullPictureCache(fileId, fullOutcome.result.data);
            if (fullOutcome.result.format === JPEG_MIME) {
              // S4: push the compressed full variant to the Rust disk cache
              // too (fire-and-forget, non-fatal — see the thumb POST above).
              // JPEG-only: an original PNG/WebP full is never POSTed.
              void postCoverToCache(fileId, false, fullOutcome.result.data);
            }
          } else {
            await captureError({
              level: "warn",
              source: META_MODULE,
              message: `cover-compress-failed (fileId=${fileId}, variant=full): ${classifyMetaError(fullOutcome.error).message}`,
              kind: classifyMetaError(fullOutcome.error).name,
            });
          }
        } catch (e: unknown) {
          // Decode failure: the single shared decode feeds both variants, so
          // one common log replaces the previous two per-variant decode logs.
          await captureError({
            level: "warn",
            source: META_MODULE,
            message: `cover-compress-failed (fileId=${fileId}, variant=decode): ${classifyMetaError(e).message}`,
            kind: classifyMetaError(e).name,
          });
        }
      }
    }
  }
}

/**
 * Unreachable when the caller passes one spec per expected variant —
 * compressCoverVariants returns exactly one outcome per spec. Defensive:
 * never index blindly into the outcomes array.
 */
function requireOutcome(
  outcomes: CoverVariantResult[],
  index: number,
): CoverVariantResult {
  const outcome = outcomes[index];
  if (!outcome) {
    throw new CoverEncodeError(
      `missing cover variant outcome at index ${String(index)}`,
    );
  }
  return outcome;
}
