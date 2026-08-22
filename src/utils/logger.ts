// Cơ chế mã hóa và ẩn Console (Anti-Leak)
// Mỗi entry gồm regex (global) và hàm redact tương ứng. Gắn type rõ ràng để
// tránh nhầm lẫn: link pattern luôn → [REDACTED_LINK] (kể cả khi url chứa
// "?id="), còn id/access_token/bearer được redact riêng biệt.
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
  // Ẩn Bearer token (case-insensitive, defense-in-depth, đồng bộ với workerError.ts)
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
