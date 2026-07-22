// Mirrors src-tauri/src/error.rs's `AppError` enum.
//
// Tauri commands migrated to `Result<T, AppError>` reject their JS promise
// with a plain object shaped like `{ kind: "Auth", message: "..." }` -- NOT
// a JS `Error` instance. Tauri's IPC layer just JSON-round-trips whatever
// the Rust side's `Err(e)` serializes to, so `err instanceof Error` is
// always `false` for these, and `String(err)` on the raw object produces
// the useless `"[object Object]"` instead of the actual message.
//
// A few call sites substring-match specific message text to decide real
// behavior, not just for logging (see src-tauri/src/error.rs's module doc
// for the full list: apiClient.ts's getValidToken checks for
// "invalid_grant"; LoginScreen.tsx checks for "timeout"/cancellation text).
// Those call sites -- and everywhere else that used to do
// `err instanceof Error ? err.message : String(err)` -- were updated to use
// `getErrorMessage`/`isAppError` below instead, so the exact same substrings
// still match correctly against the new `{kind, message}` shape.
//
// Not every command has been migrated (see AUDIT.md 7.1: "migration
// incremental, không breaking") -- `getErrorMessage` also handles a bare
// string and a native `Error` so it's safe to use uniformly regardless of
// which shape a given command currently rejects with.
export interface AppError {
  kind: 'Auth' | 'Keychain' | 'Io' | 'TaskPanicked' | 'Other';
  message: string;
}

export function isAppError(err: unknown): err is AppError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'kind' in err &&
    'message' in err &&
    typeof (err as { message: unknown }).message === 'string'
  );
}

/** Extract a human-readable message from any invoke() rejection shape. */
export function getErrorMessage(err: unknown): string {
  if (isAppError(err)) return err.message;
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}
