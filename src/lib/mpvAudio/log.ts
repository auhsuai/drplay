import { captureError } from "../../utils/errorLog";
import { THROTTLE_MS } from "../mpvProtocol";

export const LOGGER_SOURCE = "MpvAudioController";

export function logWarn(message: string): void {
  void captureError({ level: "warn", source: LOGGER_SOURCE, message });
}

export function logError(message: string): void {
  void captureError({ level: "error", source: LOGGER_SOURCE, message });
}

export function throttled(clock: { last: number }, emit: () => void): void {
  const now = Date.now();
  // `last === 0` sentinel: FIRST event always emits; Date.now() is monotonic.
  if (clock.last === 0 || now - clock.last > THROTTLE_MS) {
    clock.last = now;
    emit();
  }
}
