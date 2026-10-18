import type { UnlistenFn } from "@tauri-apps/api/event";
import type { AudioEventMap, AudioEventHandler } from "../audioNativeEvents";
import { describeError } from "../mpvProtocol";
import { logWarn } from "./log";

/** Listener registry extracted from MpvAudioController. The controller keeps
 *  `emit`/`eventIdentity` (identity needs engine state) and reads handlers
 *  from here — a one-way dependency `controller -> hub`. */
export class EventHub {
  private listeners: { [K in keyof AudioEventMap]?: AudioEventHandler<K>[] } =
    {};

  private getHandlers<K extends keyof AudioEventMap>(
    event: K,
  ): AudioEventHandler<K>[] {
    return this.listeners[event] ?? (this.listeners[event] = []);
  }

  public on<K extends keyof AudioEventMap>(
    event: K,
    handler: AudioEventHandler<K>,
  ): () => void {
    const list = this.getHandlers(event);
    list.push(handler);
    return () => {
      const idx = list.indexOf(handler);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  public handlersFor<K extends keyof AudioEventMap>(
    event: K,
  ): AudioEventHandler<K>[] | undefined {
    return this.listeners[event];
  }
}

export function detachListeners(fns: UnlistenFn[]): void {
  for (const fn of fns) {
    try {
      // Why (B6): runtime unlisten returns a promise despite UnlistenFn's
      // `() => void` signature — without this handler a rejection would
      // surface as an unhandled rejection during teardown.
      const call = fn as () => Promise<unknown> | undefined;
      void Promise.resolve(call()).catch((e: unknown) => {
        logWarn(`unlisten-failed: ${describeError(e)}`);
      });
    } catch (e: unknown) {
      logWarn(`unlisten-failed: ${describeError(e)}`);
    }
  }
}
