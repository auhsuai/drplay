import { db } from "../db/db";
import type { ErrorLogEntry } from "../db/db";

// Cơ chế redact nhạy cảm (Anti-Leak). Mỗi entry gồm regex (global) và hàm
// redact tương ứng. Gắn type rõ ràng để tránh nhầm lẫn: link pattern luôn →
// [REDACTED_LINK] (kể cả khi url chứa "?id="), còn id/access_token/bearer
// được redact riêng biệt.
// Charset giá trị chung [a-zA-Z0-9._+/=-]: hợp của base64 (+ / =) và
// base64url (- _) theo RFC 4648 §4/§5 — bắt cả token dạng "1//..." của Google.
const SENSITIVE_PATTERNS: {
  re: RegExp;
  redact: (match: string, prefix: string) => string;
}[] = [
  // Ẩn toàn bộ link proxy local chứa token/id
  {
    re: /http:\/\/127\.0\.0\.1:\d+\/[^\s"']*/g,
    redact: () => "[REDACTED_LINK]",
  },
  // Ẩn API Google Drive
  {
    re: /https:\/\/www\.googleapis\.com\/drive\/v3\/files\/[^\s"']*/g,
    redact: () => "[REDACTED_LINK]",
  },
  // Ẩn mọi string có chứa id= (id của bài hát trên drive); prefix ?/& tuỳ chọn
  {
    re: /([?&]?)id=[a-zA-Z0-9._+/=-]+/g,
    redact: (_m, p) => `${p}id=[REDACTED_ID]`,
  },
  // Drive file/folder ids logged by hooks (keys ending in "Id" or "folder")
  // — case-sensitive 'id=' above misses these; redact the value only.
  {
    re: /([?&]?)(?:dbId|driveFileId|fileId|folder)=[a-zA-Z0-9._+/=-]+/g,
    redact: (_m, p) => `${p}[REDACTED_ID]`,
  },
  // Ẩn Access Token nếu lỡ bị log ra (giữ nguyên pattern tiền tố tuỳ chọn)
  {
    re: /([?&]?)access_token=[a-zA-Z0-9._+/=-]+/g,
    redact: () => "[REDACTED_TOKEN]",
  },
  // Ẩn Refresh Token (sống lâu hơn access token nên không được log — OWASP Logging Cheat Sheet)
  {
    re: /([?&]?)refresh_token=[a-zA-Z0-9._+/=-]+/g,
    redact: () => "[REDACTED_TOKEN]",
  },
  // Ẩn token= chung (đặt sau access_token/refresh_token để key dài hơn được khớp trước)
  { re: /([?&]?)token=[a-zA-Z0-9._+/=-]+/g, redact: () => "[REDACTED_TOKEN]" },
  // Ẩn upload_id= (key lẫn value)
  { re: /([?&]?)upload_id=[a-zA-Z0-9._+/=-]+/g, redact: () => "[REDACTED_ID]" },
  // Ẩn api_key / api-key / apikey
  {
    re: /([?&]?)api[_-]?key=[a-zA-Z0-9._+/=-]+/g,
    redact: () => "[REDACTED_TOKEN]",
  },
  // Ẩn header Authorization (đứng trước Bearer để "Authorization: Bearer xyz" không bị redact 2 lần)
  {
    re: /Authorization:\s*(?:Bearer\s+)?[a-zA-Z0-9._+/=-]+/gi,
    redact: () => "Authorization: [REDACTED_TOKEN]",
  },
  // Ẩn Bearer token (case-insensitive, defense-in-depth)
  {
    re: /Bearer\s+[a-zA-Z0-9._+/=-]+/gi,
    redact: () => "Bearer [REDACTED_TOKEN]",
  },
];

export const sanitizeString = (str: string): string => {
  let sanitized = str;
  SENSITIVE_PATTERNS.forEach(({ re, redact }) => {
    // Reset lastIndex: global regex advances lastIndex on .test()/.exec(), nên
    // một pattern dùng chung có thể trả false negative ở lần gọi sau và leak.
    re.lastIndex = 0;
    sanitized = sanitized.replace(re, (match, group1: string | undefined) =>
      redact(match, group1 ?? ""),
    );
  });
  return sanitized;
};

export const sanitizeArg = (arg: unknown): unknown => {
  if (typeof arg === "string") {
    return sanitizeString(arg);
  }
  if (arg instanceof Error) {
    const newErr = new Error(sanitizeString(arg.message));
    if (arg.stack) newErr.stack = sanitizeString(arg.stack);
    newErr.name = arg.name;
    return newErr;
  }
  if (typeof arg === "object" && arg !== null) {
    try {
      const str = JSON.stringify(arg);
      // Reset lastIndex first: these patterns carry the `g` flag, and .test() on
      // a global regex advances lastIndex, so a shared module-level pattern can
      // return a false negative on a later call and leak sensitive data.
      if (
        SENSITIVE_PATTERNS.some(({ re }) => {
          re.lastIndex = 0;
          return re.test(str);
        })
      ) {
        return JSON.parse(sanitizeString(str)) as unknown;
      }
    } catch {
      // Circular structure không serialize được: trả placeholder thay vì trả raw
      // object (raw có thể chứa secret). An toàn hơn là im lặng bỏ qua.
      return "[REDACTED_UNSERIALIZABLE]";
    }
  }
  return arg;
};

export const initLogger = () => {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const originalInfo = console.info;
  const originalDebug = console.debug;

  // warn/error luôn được mã hóa link nhạy cảm (cả DEV lẫn PROD) để debug an toàn
  console.warn = (...args: unknown[]) => {
    originalWarn(...args.map(sanitizeArg));
  };
  console.error = (...args: unknown[]) => {
    originalError(...args.map(sanitizeArg));
  };

  // 1. Chế độ Môi trường Dev (Mã hóa đường link nhạy cảm)
  // console.debug cũng route qua sanitizeArg để không lộ link/secret ở dev.
  if (import.meta.env.DEV) {
    console.log = (...args: unknown[]) => {
      originalLog(...args.map(sanitizeArg));
    };
    console.info = (...args: unknown[]) => {
      originalInfo(...args.map(sanitizeArg));
    };
    console.debug = (...args: unknown[]) => {
      originalDebug(...args.map(sanitizeArg));
    };
  }

  // 2. Chế độ Sản phẩm - Production (Khóa mõm hoàn toàn Console)
  if (import.meta.env.PROD) {
    console.log = () => {};
    console.info = () => {};
    console.debug = () => {};
    // Chỉ giữ lại error nhưng đã bị mã hóa link để debug nghiêm trọng
  }
};

export const ERROR_LOG_MAX = 100;

export type { ErrorLogEntry };

export async function captureError(input: {
  level?: ErrorLogEntry["level"];
  source: string;
  message: string;
  stack?: string | undefined;
  kind?: string | undefined;
}): Promise<void> {
  try {
    const entry: ErrorLogEntry = {
      id: crypto.randomUUID(),
      ts: Date.now(),
      level: input.level ?? "error",
      source: input.source,
      message: sanitizeString(input.message),
      stack: input.stack ? sanitizeString(input.stack) : undefined,
      kind: input.kind,
    };

    // Add + count + prune trong 1 transaction để tránh race khi capture song song
    // (add rời + delete rời có thể xoá dư 1-2 entry vì count đọc giữa chừng).
    await db.transaction("rw", db.errorLogs, async () => {
      await db.errorLogs.add(entry);

      const count = await db.errorLogs.count();
      if (count > ERROR_LOG_MAX) {
        const excess = count - ERROR_LOG_MAX;
        const keys = await db.errorLogs
          .orderBy("ts")
          .limit(excess)
          .primaryKeys();
        await db.errorLogs.bulkDelete(keys);
      }
    });
  } catch (err) {
    logCaptureFailure("captureError", err);
  }
}

export async function getErrorLogs(): Promise<ErrorLogEntry[]> {
  try {
    return await db.errorLogs.orderBy("ts").reverse().toArray();
  } catch (err) {
    logCaptureFailure("getErrorLogs", err);
    return [];
  }
}

export async function clearErrorLogs(): Promise<void> {
  try {
    await db.errorLogs.clear();
  } catch (err) {
    logCaptureFailure("clearErrorLogs", err);
  }
}

function formatLogsToReport(entries: ErrorLogEntry[]): string {
  if (entries.length === 0) return "";
  return entries
    .map((e) => {
      const lines = [
        `[${new Date(e.ts).toISOString()}] ${e.level} | ${e.source}`,
        e.message,
        e.stack ?? "",
      ];
      return lines.filter((l) => l !== "").join("\n");
    })
    .join("\n---\n");
}

export async function exportErrorLogsSanitized(): Promise<string> {
  try {
    const logs = await getErrorLogs();
    if (logs.length === 0) return "";
    return formatLogsToReport(logs);
  } catch (err) {
    logCaptureFailure("exportErrorLogsSanitized", err);
    return "";
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
  dateKey: string,
): Promise<string> {
  try {
    const logs = await getErrorLogs();
    if (logs.length === 0) return "";

    const group = groupLogsByDate(logs).find((g) => g.dateKey === dateKey);
    if (!group || group.entries.length === 0) return "";

    return formatLogsToReport(group.entries);
  } catch (err) {
    logCaptureFailure(`exportErrorLogsSanitizedForDate:${dateKey}`, err);
    return "";
  }
}

// NEVER throw: a failed log capture must not crash the app.
function logCaptureFailure(scope: string, err: unknown): void {
  console.warn(
    `[${scope}] failed at ${new Date().toISOString()}: ${
      err instanceof Error ? err.message : String(err)
    }`,
  );
}
