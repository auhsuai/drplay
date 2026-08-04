import { describe, expect, it } from "vitest";
import {
  ACCESS_TOKEN_KEY,
  REFRESH_TOKEN_KEY,
  TOKEN_TIME_KEY,
} from "./storageKeys";

// Guard test: these key values are shared across useAuth, apiClient,
// useServiceWorker and useAppGlobalEvents. Renaming any of them in one place
// without the others would silently split the token session, so the exact
// string values are pinned here to fail loudly on accidental drift.
describe("storageKeys token keys", () => {
  it("pins the exact localStorage key values used by the auth modules", () => {
    expect(ACCESS_TOKEN_KEY).toBe("drplay_access_token");
    expect(REFRESH_TOKEN_KEY).toBe("drplay_refresh_token");
    expect(TOKEN_TIME_KEY).toBe("drplay_token_time");
  });
});
