import { captureError } from '../../../utils/errorLog';

// Classify an audio-engine error for observability. Only surface the
// message/name — never log tokens, URLs, or signed stream credentials.
export function classifyAudioError(err: unknown): string {
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
