import { captureError } from "../../utils/errorLog";

// Kept byte-identical to the historical module tag so existing logs and the
// tests asserting on `source` keep the same origin.
export const AUTH_MODULE = "useAuth";

export const logAuth = (
  level: "warn" | "error",
  message: string,
): Promise<void> => captureError({ level, source: AUTH_MODULE, message });
