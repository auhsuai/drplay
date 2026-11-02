import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { isAbortError } from "./player/utils";
import { getTrackMetadata } from "../utils/metadata";
import type { CachedMetadata } from "../utils/metadata";
import { METADATA_NETWORK_COOLDOWN_MS } from "../utils/metadata/constants";
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

// Retry without a remount (Phase A6): when a fetch resolves to a RETRYABLE
// provisional placeholder (transient network failure / app-wide circuit-open
// rejection) the hook re-fires once the cooldown window has elapsed. The
// budget is bounded per mount so a broken Drive can never spin a fetch loop;
// a consumer can always retry manually via the returned `retry()`.
export const METADATA_AUTO_RETRY_DELAY_MS =
  METADATA_NETWORK_COOLDOWN_MS + 1_000;
export const METADATA_MAX_AUTO_RETRIES = 2;

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
 * + cover blob URL + abort-silent error handling + cleanup (abort, timer,
 * img src). Extracted from the 4 consumers that each duplicated this machinery
 * (useSongCardMetadata, PremiumCard, TrackInfo, useNowPlayingMetadata).
 */
export function useTrackMetadata({
  fileId,
  token,
  size,
  originalName,
  enabled = true,
  debounceMs = 0,
  refreshKey,
  imgRef,
  onMetadata,
  onError,
  onCleanup,
}: TrackMetadataOptions): {
  coverUrl: string | null;
  setCoverUrl: (url: string | null) => void;
  /**
   * Manual re-fetch for the SAME mount (no remount). It never forces the
   * network — a valid cache hit is still served from memory/IDB — so calling
   * it on a loaded card costs nothing.
   */
  retry: () => void;
} {
  const [coverUrl, setCoverUrlState] = useState<string | null>(null);
  // Manual/automatic retry tick: part of the effect deps, so bumping it
  // re-runs the fetch lifecycle without remounting the consumer.
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    setAttempt((n) => n + 1);
  }, []);
  // Auto-retry budget, scoped per fileId: a new file starts fresh, and the
  // effect cleanup clears the pending timer so an unmounted card never fires.
  const autoRetriesRef = useRef(0);
  const autoRetryFileRef = useRef<string | null | undefined>(undefined);
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

    // A new file gets a fresh auto-retry budget.
    if (autoRetryFileRef.current !== fileId) {
      autoRetryFileRef.current = fileId;
      autoRetriesRef.current = 0;
    }

    const controller = new AbortController();
    let isMounted = true;
    const imgElement = imgRef?.current ?? null;
    let autoRetryTimerId: ReturnType<typeof setTimeout> | undefined;

    // Transient/circuit placeholders are PROVISIONAL: the metadata layer never
    // pins them, so a re-fetch after the cooldown can succeed WITHOUT a
    // remount. The budget is bounded per mount so a broken Drive cannot spin
    // a fetch loop; "unsupported"/"no_metadata" are final and never retried.
    function scheduleAutoRetryIfProvisional(metadata: CachedMetadata): void {
      if (
        metadata.outcome !== "transient_failure" &&
        metadata.outcome !== "circuit_open"
      ) {
        return;
      }
      if (autoRetriesRef.current >= METADATA_MAX_AUTO_RETRIES) return;
      autoRetriesRef.current += 1;
      autoRetryTimerId = setTimeout(() => {
        if (!isMounted || controller.signal.aborted) return;
        // Bumps the effect's attempt dep: one clean re-run (new controller,
        // full cleanup semantics) rather than a second in-place fetch.
        setAttempt((n) => n + 1);
      }, METADATA_AUTO_RETRY_DELAY_MS);
    }

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
        // Disk-backed entries (coverOnDisk) have no bytes — render the
        // drplay:// GET URL instead (Rust disk + moka cache), asking for the
        // FULL variant when bytes exist, the thumb otherwise.
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
        scheduleAutoRetryIfProvisional(metadata);
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

    return () => {
      isMounted = false;
      if (timerId !== undefined) clearTimeout(timerId);
      if (autoRetryTimerId !== undefined) clearTimeout(autoRetryTimerId);
      controller.abort();
      if (imgElement) imgElement.src = "";
      // The <img> no longer references the cover: release the hook-owned blob
      // URL (an already-decoded bitmap stays painted after revocation).
      if (hookBlobUrlRef.current !== null) {
        revokeCoverBlobUrl(hookBlobUrlRef.current);
        hookBlobUrlRef.current = null;
      }
      onCleanup?.();
    };
  }, [
    enabled,
    fileId,
    token,
    size,
    originalName,
    debounceMs,
    refreshKey,
    attempt,
    imgRef,
    onMetadata,
    onError,
    onCleanup,
  ]);

  return { coverUrl, setCoverUrl, retry };
}
