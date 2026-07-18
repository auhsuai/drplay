import { db } from '../db/db';
import type { ErrorLogEntry } from '../db/db';
import { sanitizeString } from './logger';

export const ERROR_LOG_MAX = 100;

export type { ErrorLogEntry };

export async function captureError(input: {
  level?: ErrorLogEntry['level'];
  source: string;
  message: string;
  stack?: string;
  kind?: string;
}): Promise<void> {
  try {
    const entry: ErrorLogEntry = {
      id: crypto.randomUUID(),
      ts: Date.now(),
      level: input.level ?? 'error',
      source: input.source,
      message: sanitizeString(input.message),
      stack: input.stack ? sanitizeString(input.stack) : undefined,
      kind: input.kind
    };

    await db.errorLogs.add(entry);

    const count = await db.errorLogs.count();
    if (count > ERROR_LOG_MAX) {
      const excess = count - ERROR_LOG_MAX;
      const oldest = await db.errorLogs.orderBy('ts').limit(excess).toArray();
      const idsToRemove = oldest.map((e) => e.id);
      if (idsToRemove.length > 0) {
        await db.errorLogs.bulkDelete(idsToRemove);
      }
    }
  } catch (err) {
    // NEVER throw: a failed log capture must not crash the app.
    console.warn(
      `[captureError] failed to persist error log at ${new Date().toISOString()}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

export async function getErrorLogs(): Promise<ErrorLogEntry[]> {
  try {
    return await db.errorLogs.orderBy('ts').reverse().toArray();
  } catch (err) {
    console.warn(
      `[getErrorLogs] failed to read error logs at ${new Date().toISOString()}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return [];
  }
}

export async function clearErrorLogs(): Promise<void> {
  try {
    await db.errorLogs.clear();
  } catch (err) {
    console.warn(
      `[clearErrorLogs] failed to clear error logs at ${new Date().toISOString()}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

export async function exportErrorLogsSanitized(): Promise<string> {
  try {
    const logs = await getErrorLogs();
    if (logs.length === 0) return '';

    return logs
      .map((e) => {
        const lines = [
          `[${new Date(e.ts).toISOString()}] ${e.level} | ${e.source}`,
          e.message,
          e.stack ?? ''
        ];
        return lines.filter((l) => l !== '').join('\n');
      })
      .join('\n---\n');
  } catch (err) {
    console.warn(
      `[exportErrorLogsSanitized] failed to export at ${new Date().toISOString()}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return '';
  }
}
