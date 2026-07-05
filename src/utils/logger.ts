// Cơ chế mã hóa và ẩn Console (Anti-Leak)
const SENSITIVE_PATTERNS = [
  // Ẩn toàn bộ link proxy local chứa token/id
  /http:\/\/127\.0\.0\.1:\d+\/[^\s"']*/g, 
  // Ẩn API Google Drive
  /https:\/\/www\.googleapis\.com\/drive\/v3\/files\/[^\s"']*/g, 
  // Ẩn mọi string có chứa id= (id của bài hát trên drive)
  /([?&])id=[a-zA-Z0-9_-]+/g, 
  // Ẩn Access Token nếu lỡ bị log ra
  /([?&])access_token=[a-zA-Z0-9._-]+/g
];

const sanitizeString = (str: string) => {
  let sanitized = str;
  SENSITIVE_PATTERNS.forEach(pattern => {
    sanitized = sanitized.replace(pattern, (match, group1) => {
      // Nếu là match từ các regex có group1 (?id= hoặc &id=)
      if (group1 === '?' || group1 === '&') {
        return match.includes('id=') ? `${group1}id=[REDACTED_ID]` : `${group1}access_token=[REDACTED_TOKEN]`;
      }
      return '[REDACTED_LINK]';
    });
  });
  return sanitized;
};

const sanitizeArg = (arg: any): any => {
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
      if (SENSITIVE_PATTERNS.some(p => p.test(str))) {
         return JSON.parse(sanitizeString(str));
      }
    } catch(e) {
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

  // 1. Chế độ Môi trường Dev (Mã hóa đường link nhạy cảm)
  console.log = (...args) => originalLog(...args.map(sanitizeArg));
  console.warn = (...args) => originalWarn(...args.map(sanitizeArg));
  console.error = (...args) => originalError(...args.map(sanitizeArg));
  console.info = (...args) => originalInfo(...args.map(sanitizeArg));
  
  // 2. Chế độ Sản phẩm - Production (Khóa mõm hoàn toàn Console)
  if (import.meta.env.PROD) {
    console.log = () => {};
    console.info = () => {};
    console.debug = () => {};
    // Chỉ giữ lại error nhưng đã bị mã hóa link để debug nghiêm trọng
  }
};

// Đính kèm vào window để Dev thử nghiệm gọi ngầm
(window as any).testLeak = () => {
  console.log("Đây là link bí mật của tôi: http://127.0.0.1:62216/stream?id=1RoFd1kOvoIn_0C8vmcuUHZ4DdZEx01pp&ext=mp3");
  console.error("Lỗi fetch API: https://www.googleapis.com/drive/v3/files/1RoFd1kOvoIn_0C8vmcuUHZ4DdZEx01pp?alt=media");
  console.log({ user: "admin", fileId: "?id=1RoFd1kOvoIn_0C8vmcuUHZ4DdZEx01pp" });
};
