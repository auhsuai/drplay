import { useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { describeError } from "../lib/mpvProtocol";
import { showContextMenu, type NativeMenuPosition } from "../lib/nativeMenu";
import { captureError } from "../utils/errorLog";
import { showErrorToast } from "../utils/simpleToast";
import type { PlayerCommandContext } from "./commands";
import {
  buildContextMenuModel,
  runMenuEntry,
  takeVideoMenuSnapshot,
  type MenuSection,
} from "./menuModel";

/** Rust-side event carrying the right-click position in physical screen px. */
export const VIDEO_CONTEXT_MENU_EVENT = "video-context-menu";

export interface VideoContextMenuPayload {
  x: number;
  y: number;
}

interface UseVideoContextMenuOptions {
  ctx: PlayerCommandContext;
  /** True while a VIDEO track is loaded — the only state Rust emits for. */
  isVideoActive: boolean;
}

const LOGGER_SOURCE = "videoContextMenu";

/**
 * One menu interaction (right-click OR a playerbar button) end to end:
 * snapshot -> section model -> native popup -> dispatch the selected id.
 * `at` omitted => Rust anchors the popup at the cursor — for a bar button
 * that is the button itself (spec §19). Every failure is surfaced as an error
 * toast, never as a crash, so fire-and-forget callers stay safe.
 */
export async function openVideoMenuSection(
  section: MenuSection,
  ctx: PlayerCommandContext,
  isFullscreen: boolean,
  at?: NativeMenuPosition,
): Promise<void> {
  try {
    const snapshot = await takeVideoMenuSnapshot(isFullscreen);
    const model = buildContextMenuModel(section, snapshot);
    const selected =
      at === undefined
        ? await showContextMenu(model)
        : await showContextMenu(model, at);
    if (selected !== null) {
      await runMenuEntry(selected, ctx, snapshot);
    }
  } catch (e: unknown) {
    showErrorToast(describeError(e));
  }
}

/**
 * Wire the native video right-click (event from video_host.rs) to the menu:
 * the same single flow the bar buttons use, with the event's x/y as the
 * anchor. The listener exists only while a video is loaded.
 */
export function useVideoContextMenu({
  ctx,
  isVideoActive,
}: UseVideoContextMenuOptions): void {
  const contextRef = useRef(ctx);
  useEffect(() => {
    contextRef.current = ctx;
  });

  useEffect(() => {
    if (!isVideoActive) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;

    const handleContextMenu = (
      payload: VideoContextMenuPayload,
    ): Promise<void> => {
      const context = contextRef.current;
      return openVideoMenuSection("full", context, context.isFullscreen, {
        x: payload.x,
        y: payload.y,
      });
    };

    void listen<VideoContextMenuPayload>(VIDEO_CONTEXT_MENU_EVENT, (event) => {
      void handleContextMenu(event.payload);
    })
      .then((stopListening) => {
        // The effect may have been cleaned up while `listen` was resolving.
        if (disposed) stopListening();
        else unlisten = stopListening;
      })
      .catch((e: unknown) => {
        void captureError({
          level: "warn",
          source: LOGGER_SOURCE,
          message: `listen-failed: ${describeError(e)}`,
          kind: "video-context-menu-listen-failed",
        });
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [isVideoActive]);
}
