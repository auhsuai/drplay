export const FOLDER_MODULE = "FolderSelection";
export const SEARCH_DEBOUNCE_MS = 300;

// Classify a Drive fetch error for observability. Returns name + message only.
export function classifyFolderError(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err;
  const message = err instanceof Error ? err.message : String(err);
  return `${name}: ${message}`;
}

// fetch aborts (AbortController/AbortSignal) reject with a DOMException named
// 'AbortError' — the caller requested the cancellation, so it must not be
// surfaced as a user-facing error. Check both shapes: browsers' DOMException
// extends Error, but jsdom's implementation does not.
export function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === "AbortError") return true;
  return (
    typeof DOMException !== "undefined" &&
    err instanceof DOMException &&
    err.name === "AbortError"
  );
}

// Race guard: cancelFolderFetch() aborts the controller from OUTSIDE this
// function while an await is in flight, so signal.aborted is genuinely
// reachable here even though typescript-eslint's flow analysis narrows a
// freshly-created controller's signal to "never aborted". The indirection
// keeps the check opaque to that narrowing.
export function isAborted(controller: AbortController): boolean {
  return controller.signal.aborted;
}

export interface FolderItem {
  id: string;
  name: string;
}
