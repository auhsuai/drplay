import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { describeError } from "./shared";

export interface EventWaiter {
  promise: Promise<void>;
  dispose: () => void;
}

export async function armEvent(
  event: string,
  timeoutMs: number,
  matches?: (payload: unknown) => boolean,
): Promise<EventWaiter> {
  const lifecycle: {
    settled: boolean;
    timer: number | undefined;
    unlisten: UnlistenFn | undefined;
  } = { settled: false, timer: undefined, unlisten: undefined };
  let resolveReady: () => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const succeed = (): void => {
    if (lifecycle.settled) return;
    lifecycle.settled = true;
    if (lifecycle.timer !== undefined) window.clearTimeout(lifecycle.timer);
    lifecycle.unlisten?.();
    resolveReady();
  };
  const fail = (error: Error): void => {
    if (lifecycle.settled) return;
    lifecycle.settled = true;
    if (lifecycle.timer !== undefined) window.clearTimeout(lifecycle.timer);
    lifecycle.unlisten?.();
    rejectReady(error);
  };
  const dispose = (): void => {
    if (lifecycle.settled) return;
    lifecycle.settled = true;
    if (lifecycle.timer !== undefined) window.clearTimeout(lifecycle.timer);
    lifecycle.unlisten?.();
  };

  try {
    lifecycle.unlisten = await listen(event, (incoming) => {
      if (matches !== undefined && !matches(incoming.payload)) return;
      succeed();
    });
  } catch (error) {
    lifecycle.settled = true;
    throw new Error(`listen(${event}) failed: ${describeError(error)}`);
  }

  if (lifecycle.settled) {
    lifecycle.unlisten();
    return { promise, dispose: () => undefined };
  }

  lifecycle.timer = window.setTimeout(() => {
    fail(
      new Error(`Timed out after ${String(timeoutMs)}ms waiting for ${event}`),
    );
  }, timeoutMs);

  return { promise, dispose };
}
