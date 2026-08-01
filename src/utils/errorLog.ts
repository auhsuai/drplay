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
      await db.errorLogs.orderBy('ts').limit(excess).delete();
    }
  } catch (err) {
    logCaptureFailure('captureError', err);
  }
}

export async function getErrorLogs(): Promise<ErrorLogEntry[]> {
  try {
    return await db.errorLogs.orderBy('ts').reverse().toArray();
  } catch (err) {
    logCaptureFailure('getErrorLogs', err);
    return [];
  }
}

export async function clearErrorLogs(): Promise<void> {
  try {
    await db.errorLogs.clear();
  } catch (err) {
    logCaptureFailure('clearErrorLogs', err);
  }
}

function formatLogsToReport(entries: ErrorLogEntry[]): string {
  if (entries.length === 0) return '';
  return entries
    .map((e) => {
      const lines = [
        `[${new Date(e.ts).toISOString()}] ${e.level} | ${e.source}`,
        e.message,
        e.stack ?? ''
      ];
      return lines.filter((l) => l !== '').join('\n');
    })
    .join('\n---\n');
}

export async function exportErrorLogsSanitized(): Promise<string> {
  try {
    const logs = await getErrorLogs();
    if (logs.length === 0) return '';
    return formatLogsToReport(logs);
  } catch (err) {
    logCaptureFailure('exportErrorLogsSanitized', err);
    return '';
  }
}

export interface LogDateGroup {
  dateKey: string;
  entries: ErrorLogEntry[];
}

export function groupLogsByDate(logs: ErrorLogEntry[]): LogDateGroup[] {
  // Pure function: never throws.
  // dateKey uses toLocaleDateString() in LOCAL timezone as BOTH the group
  // key and the display label. Using the same string for key+display keeps
  // grouping and rendering consistent and avoids timezone-mismatch bugs
  // (where an entry's key would not match the label it is shown under).
  // See MDN: Date.prototype.toLocaleDateString() returns the date portion
  // interpreted in the local timezone.
  const byDate = new Map<string, ErrorLogEntry[]>();

  for (const entry of logs) {
    const d = new Date(entry.ts);
    if (Number.isNaN(d.getTime())) continue;
    const dateKey = d.toLocaleDateString();
    const bucket = byDate.get(dateKey);
    if (bucket) {
      bucket.push(entry);
    } else {
      byDate.set(dateKey, [entry]);
    }
  }

  const groups: LogDateGroup[] = [];
  for (const [dateKey, entries] of byDate.entries()) {
    // Entries within a group sorted newest-first by ts.
    const sorted = [...entries].sort((a, b) => b.ts - a.ts);
    groups.push({ dateKey, entries: sorted });
  }

  // Groups sorted newest-first (largest ts on top).
  groups.sort((a, b) => {
    const aMax = a.entries.reduce((m, e) => Math.max(m, e.ts), 0);
    const bMax = b.entries.reduce((m, e) => Math.max(m, e.ts), 0);
    return bMax - aMax;
  });

  return groups;
}

export async function exportErrorLogsSanitizedForDate(
  dateKey: string
): Promise<string> {
  try {
    const logs = await getErrorLogs();
    if (logs.length === 0) return '';

    const group = groupLogsByDate(logs).find((g) => g.dateKey === dateKey);
    if (!group || group.entries.length === 0) return '';

    return formatLogsToReport(group.entries);
  } catch (err) {
    logCaptureFailure(`exportErrorLogsSanitizedForDate:${dateKey}`, err);
    return '';
  }
}

// NEVER throw: a failed log capture must not crash the app.
function logCaptureFailure(scope: string, err: unknown): void {
  console.warn(
    `[${scope}] failed at ${new Date().toISOString()}: ${
      err instanceof Error ? err.message : String(err)
    }`
  );
}
