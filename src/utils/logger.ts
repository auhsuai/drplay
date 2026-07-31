// Cơ chế mã hóa và ẩn Console (Anti-Leak)
// Mỗi entry gồm regex (global) và hàm redact tương ứng. Gắn type rõ ràng để
// tránh nhầm lẫn: link pattern luôn → [REDACTED_LINK] (kể cả khi url chứa
// "?id="), còn id/access_token/bearer được redact riêng biệt.
const SENSITIVE_PATTERNS: { re: RegExp; redact: (match: string, prefix: string) => string }[] = [
  // Ẩn toàn bộ link proxy local chứa token/id
  { re: /http:\/\/127\.0\.0\.1:\d+\/[^\s"']*/g, redact: () => '[REDACTED_LINK]' },
  // Ẩn API Google Drive
  { re: /https:\/\/www\.googleapis\.com\/drive\/v3\/files\/[^\s"']*/g, redact: () => '[REDACTED_LINK]' },
  // Ẩn mọi string có chứa id= (id của bài hát trên drive); prefix ?/& tuỳ chọn
  { re: /([?&]?)id=[a-zA-Z0-9_-]+/g, redact: (_m, p) => `${p}id=[REDACTED_ID]` },
  // Ẩn Access Token nếu lỡ bị log ra (giữ nguyên pattern tiền tố tuỳ chọn)
  { re: /([?&]?)access_token=[a-zA-Z0-9._-]+/g, redact: () => '[REDACTED_TOKEN]' },
  // Ẩn Bearer token (defense-in-depth, đồng bộ với workerError.ts)
  { re: /Bearer\s+[a-zA-Z0-9._-]+/g, redact: () => 'Bearer [REDACTED_TOKEN]' }
];

export const sanitizeString = (str: string): string => {
  let sanitized = str;
  SENSITIVE_PATTERNS.forEach(({ re, redact }) => {
    // Reset lastIndex: global regex advances lastIndex on .test()/.exec(), nên
    // một pattern dùng chung có thể trả false negative ở lần gọi sau và leak.
    re.lastIndex = 0;
    sanitized = sanitized.replace(re, (match, group1) => redact(match, group1 || ''));
  });
  return sanitized;
};

export const sanitizeArg = (arg: any): any => {
  if (typeof arg === 'string') {
    return sanitizeString(arg);
  }
  if (arg instanceof Error) {
    const newErr = new Error(sanitizeString(arg.message));
    newErr.stack = arg.stack ? sanitizeString(arg.stack) : undefined;
    newErr.name = arg.name;
    return newErr;
  }
  if (typeof arg === 'object' && arg !== null) {
    try {
      const str = JSON.stringify(arg);
      // Reset lastIndex first: these patterns carry the `g` flag, and .test() on
      // a global regex advances lastIndex, so a shared module-level pattern can
      // return a false negative on a later call and leak sensitive data.
      if (SENSITIVE_PATTERNS.some(({ re }) => { re.lastIndex = 0; return re.test(str); })) {
         return JSON.parse(sanitizeString(str));
      }
    } catch(e: unknown) {
      // Ignore circular structures
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
  console.warn = (...args) => originalWarn(...args.map(sanitizeArg));
  console.error = (...args) => originalError(...args.map(sanitizeArg));

  // 1. Chế độ Môi trường Dev (Mã hóa đường link nhạy cảm)
  // console.debug cũng route qua sanitizeArg để không lộ link/secret ở dev.
  if (import.meta.env.DEV) {
    console.log = (...args) => originalLog(...args.map(sanitizeArg));
    console.info = (...args) => originalInfo(...args.map(sanitizeArg));
    console.debug = (...args) => originalDebug(...args.map(sanitizeArg));
  }

  // 2. Chế độ Sản phẩm - Production (Khóa mõm hoàn toàn Console)
  if (import.meta.env.PROD) {
    console.log = () => {};
    console.info = () => {};
    console.debug = () => {};
    // Chỉ giữ lại error nhưng đã bị mã hóa link để debug nghiêm trọng
  }
};
