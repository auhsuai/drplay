// Barrel re-export for the auth/HTTP client. The implementation previously
// exported from this file now lives in split modules (apiClientShared /
// tokenRefresh / refreshTokenStore / authFetch) — every consumer keeps
// importing from ./apiClient, so import paths and signatures stay stable
// and the vitest mocks that target this path keep working.
export { TokenRefreshError } from "./apiClientShared";
export {
  TOKEN_EXPIRY_MS,
  stopProactiveRefresh,
  computeProactiveRefreshDelayMs,
  scheduleProactiveRefresh,
  getValidToken,
} from "./tokenRefresh";
export {
  revokeGoogleToken,
  readRefreshToken,
  writeRefreshToken,
  deleteRefreshToken,
} from "./refreshTokenStore";
export type { FetchWithAuthOptions } from "./authFetch";
export { fetchWithAuth } from "./authFetch";
