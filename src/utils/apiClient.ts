// Facade over the auth/api-client suite split by topic (src/utils/):
//   apiClientShared    — TokenRefreshError + promise/time-out/abort helpers
//   refreshTokenStore  — keyring-backed refresh-token storage + revoke
//   tokenRefresh       — getValidToken (single-flight refresh + retry/proactive)
//   authFetch          — fetchWithAuth (timeout-bounded 401-retry fetch)
// Consumers keep importing from "./apiClient"; nothing else changes.
export { TokenRefreshError } from "./apiClientShared";
export {
  computeProactiveRefreshDelayMs,
  getValidToken,
  scheduleProactiveRefresh,
  stopProactiveRefresh,
  TOKEN_EXPIRY_MS,
} from "./tokenRefresh";
export {
  deleteRefreshToken,
  readRefreshToken,
  revokeGoogleToken,
  writeRefreshToken,
} from "./refreshTokenStore";
export type { FetchWithAuthOptions } from "./authFetch";
export { fetchWithAuth } from "./authFetch";
