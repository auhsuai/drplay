import type { InternalEntry } from "./types";

// One AbortController per in-flight upload: created when the entry turns
// 'uploading' (before handleByKind) and removed at terminal. cancelUpload
// aborts it; driveApi converts the abort into UploadError('aborted') which
// markError surfaces as a silent user-initiated cancel.
const entryControllers = new Map<string, AbortController>();

export function controllerFor(
  entry: InternalEntry,
): AbortController | undefined {
  return entryControllers.get(entry.id);
}
export function createControllerFor(entry: InternalEntry): void {
  entryControllers.set(entry.id, new AbortController());
}
export function clearControllerFor(entry: InternalEntry): void {
  entryControllers.delete(entry.id);
}
