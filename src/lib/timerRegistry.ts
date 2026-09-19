/**
 * Playback timer registry (audit RC-10 / P9 S9-2): every playback-owned timer
 * arms through the registry under a name and every clear unregisters it, so
 * `activeTimerCount()` answers "which timers are alive?" in one place and
 * `release()` can assert an empty registry instead of trusting five scattered
 * clear sites. Pure wrapper around the native timer functions: exactly one
 * native timer per arm (no extra timer must appear), and none of the existing
 * generation/self-stop semantics change — machines keep owning their handles.
 */

export class TimerRegistry {
  private readonly active = new Map<ReturnType<typeof setTimeout>, string>();

  setTimeout(
    name: string,
    fn: () => void,
    ms: number,
  ): ReturnType<typeof setTimeout> {
    // Self-drop on fire: a fired timeout is no longer active, and its owner
    // clears the field without ever calling back into the registry.
    const handle = setTimeout(() => {
      this.active.delete(handle);
      fn();
    }, ms);
    this.active.set(handle, name);
    return handle;
  }

  clearTimeout(handle: ReturnType<typeof setTimeout> | null): void {
    if (handle === null) return;
    this.active.delete(handle);
    globalThis.clearTimeout(handle);
  }

  setInterval(
    name: string,
    fn: () => void,
    ms: number,
  ): ReturnType<typeof setInterval> {
    const handle = globalThis.setInterval(fn, ms);
    this.active.set(handle, name);
    return handle;
  }

  clearInterval(
    handle: ReturnType<typeof setInterval> | null | undefined,
  ): void {
    if (handle === null || handle === undefined) return;
    this.active.delete(handle);
    globalThis.clearInterval(handle);
  }

  activeTimerCount(): number {
    return this.active.size;
  }

  activeTimerNames(): string[] {
    return [...this.active.values()];
  }
}
