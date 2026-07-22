import { captureError } from '../../../utils/errorLog';
import { isAppError } from '../../../utils/appError';

// Classify an audio-engine error for observability. Only surface the
// message/name — never log tokens, URLs, or signed stream credentials.
export function classifyAudioError(err: unknown): string {
  // get_stream_url (src-tauri/src/commands/misc.rs) now types its Err side
  // as AppError -- a {kind, message} object, not an Error instance.
  if (isAppError(err)) return err.message;
  if (err instanceof Error) {
    return err.message || err.name || 'Unknown audio error';
  }
  if (typeof err === 'string') return err;
  return 'Unknown audio error';
}

// Fire-and-forget retry helper: `performRetry` already surfaces the failure to
// the UI, but swallowing its rejection with `.catch(() => {})` hides the failure
// from the persisted error log. Capture it (sanitized, no secrets) instead.
export function captureRetryFailure(where: string, e: unknown): void {
  captureError({
    level: 'warn',
    source: 'audio-engine',
    message: `${where}: retry failed (${classifyAudioError(e)})`,
    kind: 'retry',
  });
}
