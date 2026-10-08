import { captureError } from "../utils/errorLog";

/**
 * Tiny event bus for player-UI effects that the keyboard command registry
 * cannot perform itself (dialogs, toasts, external volume sync). Deliberately
 * NOT window events: subscribers are React components that register exactly
 * once, and a DOM CustomEvent would leak the player's UI vocabulary into the
 * global event namespace.
 */

export type PlayerUiToastVariant = "error" | "success";

export interface PlayerUiToastPayload {
  message: string;
  variant: PlayerUiToastVariant;
}

export interface PlayerUiVolumePayload {
  volume: number;
  muted: boolean;
}

export type PlayerUiEvent =
  | { kind: "media-info" }
  | { kind: "toast"; payload: PlayerUiToastPayload }
  | { kind: "volume-changed"; volume: number; muted: boolean };

export type PlayerUiEventKind = PlayerUiEvent["kind"];

type PlayerUiHandler = (event: PlayerUiEvent) => void;

const handlers = new Set<PlayerUiHandler>();

function toEvent(
  kind: PlayerUiEventKind,
  payload: PlayerUiToastPayload | PlayerUiVolumePayload | undefined,
): PlayerUiEvent {
  if (kind === "media-info") return { kind: "media-info" };
  if (payload === undefined) {
    throw new Error(`emitPlayerUi: a payload is required for '${kind}'`);
  }
  if (kind === "toast") {
    if (!("message" in payload)) {
      throw new Error("emitPlayerUi: toast payload must carry a message");
    }
    return { kind: "toast", payload };
  }
  if (!("volume" in payload)) {
    throw new Error("emitPlayerUi: volume payload must carry a volume");
  }
  return {
    kind: "volume-changed",
    volume: payload.volume,
    muted: payload.muted,
  };
}

export function emitPlayerUi(kind: "media-info"): void;
export function emitPlayerUi(
  kind: "toast",
  payload: PlayerUiToastPayload,
): void;
export function emitPlayerUi(
  kind: "volume-changed",
  payload: PlayerUiVolumePayload,
): void;
export function emitPlayerUi(
  kind: PlayerUiEventKind,
  payload?: PlayerUiToastPayload | PlayerUiVolumePayload,
): void {
  const event = toEvent(kind, payload);

  // Iterate a snapshot: a handler may unsubscribe itself mid-dispatch.
  for (const handler of [...handlers]) {
    try {
      handler(event);
    } catch (e: unknown) {
      // One broken subscriber must never starve the others; log with context.
      void captureError({
        level: "warn",
        source: "playerUiBus",
        message: `player-ui-handler-failed kind=${kind}: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
}

export function onPlayerUi(handler: PlayerUiHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}
