import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { isAbortError } from "./player/utils";
import { getTrackMetadata } from "../utils/metadata";
import type { CachedMetadata } from "../utils/metadata";
import { METADATA_UPDATED_EVENT } from "../utils/metadata/constants";
import {
  buildCoverBlobUrl,
  buildCoverUrl,
  revokeCoverBlobUrl,
} from "../utils/coverStore";

// Single source of truth for the metadata-fetch debounce window shared by the
// card-style consumers (SongCard / PremiumCard): fetch only if the consumer
// stays mounted for the window — avoids IPC/range-fetch spam when a large
// grid mounts many cards at once.
export const TRACK_METADATA_DEBOUNCE_MS = 150;

export interface TrackMetadataOptions {
  fileId: string | null | undefined;
  // Explicit | undefined so consumers can pass through optional fields
  // (exactOptionalPropertyTypes forbids writing undefined into an optional
  // property that does not declare it).
  token?: string | null | undefined;
  size?: number | undefined;
  originalName?: string | undefined;
  /** Guard flag: when false the effect does nothing (consumer-side guard, e.g. isFolder / missing token). */
  enabled?: boolean;
  /** Debounce window in ms; 0 (default) fetches immediately. */
  debounceMs?: number;
  /** Re-fetch when the matching metadata-updated event fires (SongCard only). */
  listenMetadataUpdated?: boolean;
  /** Extra dependency: re-fetch when it changes (consumer-specific values the fetch args cannot express). */
  refreshKey?: unknown;
  /** The <img> the cover renders into; its src is cleared on cleanup. Captured at setup so the cleanup never reads the (possibly stale) ref (react-hooks/exhaustive-deps ref-cleanup rule). */
  imgRef?: RefObject<HTMLImageElement | null>;
  /**
   * Called after a resolved fetch (post-abort-check) with the resolved
   * metadata, the cover blob URL (null when the track has no picture) and
   * the abort signal — consumers that keep awaiting beyond the hook (e.g.
   * NowPlaying's palette decode) read signal.aborted to drop stale work.
   */
  onMetadata: (
    metadata: CachedMetadata,
    coverUrl: string | null,
    signal: AbortSignal,
  ) => void;
  /** Called with a non-abort fetch failure (aborts stay silent). */
  onError: (error: unknown) => void;
  /** Extra cleanup work for consumer state the hook cannot reach (e.g. NowPlaying's palette reset). Runs on every cleanup. */
  onCleanup?: () => void;
}

/**
 * Shared track-metadata fetch lifecycle: AbortController + optional debounce
 * + optional metadata-updated listener + cover blob URL + abort-silent error
 * handling + cleanup (abort, timer, img src, listener). Extracted from the
 * 4 consumers that each duplicated this machinery (useSongCardMetadata,
 * PremiumCard, TrackInfo, useNowPlayingMetadata).
 */
export function useTrackMetadata({
  fileId,
  token,
  size,
  originalName,
  enabled = true,
  debounceMs = 0,
  listenMetadataUpdated = false,
  refreshKey,
  imgRef,
  onMetadata,
  onError,
  onCleanup,
}: TrackMetadataOptions): {
  coverUrl: string | null;
  setCoverUrl: (url: string | null) => void;
} {
  const [coverUrl, setCoverUrlState] = useState<string | null>(null);
  // Blob URL last created by THIS hook with buildCoverBlobUrl (null while the
  // cover is a drplay:// GET URL, no cover, or already released). Tracked
  // across effect runs so the hook revokes exactly the URL it owns — never a
  // consumer-owned URL — and only after the URL stopped being displayed.
  const hookBlobUrlRef = useRef<string | null>(null);
  // Consumer-facing clear (e.g. <img> error): the hook-created URL is no
  // longer referenced by state, so release its bytes. Non-null URLs are set
  // as-is (consumers only ever clear; ownership of their URLs stays theirs).
  const setCoverUrl = useCallback((url: string | null) => {
    if (url === null && hookBlobUrlRef.current !== null) {
      revokeCoverBlobUrl(hookBlobUrlRef.current);
      hookBlobUrlRef.current = null;
    }
    setCoverUrlState(url);
  }, []);

  useEffect(() => {
    if (!enabled || !fileId) return;

    const controller = new AbortController();
    let isMounted = true;
    const imgElement = imgRef?.current ?? null;

    const fetchMetadata = async () => {
      try {
        const metadata = await getTrackMetadata(
          fileId,
          token ?? undefined,
          size,
          originalName,
          controller.signal,
        );
        if (!isMounted || controller.signal.aborted) return;
        // Fix G: the cover renders straight from a blob URL built with the
        // picture bytes metadata already parsed — full (≤1000px) bytes win
        // over the 256px thumb; a missing picture keeps the consumer's icon.
        // Seed offline (2026-08-10): disk entries (coverOnDisk) have no bytes
        // — render the drplay:// GET URL instead (Rust disk + moka cache),
        // asking for the FULL variant when bytes exist, the thumb otherwise.
        const fullBytes = metadata.pictureDataFull;
        const coverBytes = fullBytes ?? metadata.pictureData;
        let nextCoverUrl: string | null;
        let nextHookBlobUrl: string | null = null;
        if (metadata.coverOnDisk) {
          nextCoverUrl = buildCoverUrl(fileId, !metadata.pictureDataFull);
        } else if (coverBytes) {
          // The blob MIME must follow the bytes actually rendered: the full
          // variant carries its own format (a PNG/WebP original can sit behind
          // a re-encoded JPEG thumb), while the thumb fallback keeps the
          // thumb format.
          nextCoverUrl = buildCoverBlobUrl(
            coverBytes,
            fullBytes
              ? (metadata.pictureFullFormat ?? metadata.pictureFormat)
              : metadata.pictureFormat,
          );
          nextHookBlobUrl = nextCoverUrl;
        } else {
          nextCoverUrl = null;
        }
        // Release the previous hook-owned blob only AFTER the state swap to
        // the new URL: several consumers (the <img>, NowPlaying's palette
        // decode) may still hold the displayed URL, so it must not be cut
        // while it is the one on screen.
        const previousHookBlobUrl = hookBlobUrlRef.current;
        hookBlobUrlRef.current = nextHookBlobUrl;
        setCoverUrlState(nextCoverUrl);
        if (
          previousHookBlobUrl !== null &&
          previousHookBlobUrl !== nextCoverUrl
        ) {
          revokeCoverBlobUrl(previousHookBlobUrl);
        }
        onMetadata(metadata, nextCoverUrl, controller.signal);
      } catch (error) {
        // Deliberate cleanup abort (or an AbortError from the fetch layer) is
        // not an error (MDN AbortController) — stay silent.
        if (controller.signal.aborted || isAbortError(error)) return;
        onError(error);
      }
    };

    let timerId: ReturnType<typeof setTimeout> | undefined;
    if (debounceMs > 0) {
      timerId = setTimeout(() => {
        void fetchMetadata();
      }, debounceMs);
    } else {
      void fetchMetadata();
    }

    let removeMetadataListener: (() => void) | undefined;
    if (listenMetadataUpdated) {
      const handleMetadataUpdated = (e: Event) => {
        // detail is typed | null because a CustomEvent constructed without
        // the detail option defaults to null at runtime.
        const customEvent = e as CustomEvent<{ fileId?: string } | null>;
        if (customEvent.detail?.fileId === fileId) {
          void fetchMetadata();
        }
      };
      window.addEventListener(METADATA_UPDATED_EVENT, handleMetadataUpdated);
      removeMetadataListener = () => {
        window.removeEventListener(
          METADATA_UPDATED_EVENT,
          handleMetadataUpdated,
        );
      };
    }

    return () => {
      isMounted = false;
      if (timerId !== undefined) clearTimeout(timerId);
      controller.abort();
      if (imgElement) imgElement.src = "";
      // The <img> no longer references the cover: release the hook-owned blob
      // URL (an already-decoded bitmap stays painted after revocation).
      if (hookBlobUrlRef.current !== null) {
        revokeCoverBlobUrl(hookBlobUrlRef.current);
        hookBlobUrlRef.current = null;
      }
      removeMetadataListener?.();
      onCleanup?.();
    };
  }, [
    enabled,
    fileId,
    token,
    size,
    originalName,
    debounceMs,
    listenMetadataUpdated,
    refreshKey,
    imgRef,
    onMetadata,
    onError,
    onCleanup,
  ]);

  return { coverUrl, setCoverUrl };
}
