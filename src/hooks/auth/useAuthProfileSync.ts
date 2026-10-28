import { useEffect } from "react";
import { fetchWithAuth } from "../../utils/apiClient";
import { authHeaders } from "../../utils/driveFiles";
import { getCurrentSessionId } from "../../utils/sessionGuard";
import { sleep } from "../../utils/retryDelay";
import { USER_EMAIL_KEY } from "../../utils/storageKeys";
import { useAuthStore } from "../../store/authStore";
import { isAbortError } from "../player/utils";
import { logAuth } from "./authLog";

const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

// Cold-start resilience for the best-effort profile fetch: on slow networks
// the single attempt used to fail and leave USER_EMAIL_KEY unset for the
// whole session, which permanently blocked the pro-sync sentinel guard
// (resolveWireUserEmail). 3 total attempts with exponential-ish backoff
// (0s/2s/4s); every intermediate failure warns with the attempt number and an
// AbortError exits without retrying (AbortController semantics preserved).
const PROFILE_FETCH_RETRY_MAX = 3;
const PROFILE_FETCH_RETRY_BASE_MS = 2000;

export interface AuthProfileSyncDeps {
  isLoggedIn: boolean;
  accessToken: string | null;
}

/**
 * Fetches the Google profile (best-effort, fire-and-forget) whenever the
 * session is active. Keyed on [isLoggedIn, accessToken] on purpose: the
 * profile should refetch whenever the token rotates.
 *
 * The AbortController only cancels the in-flight fetch (and the backoff sleep)
 * — it must NOT touch the worker, which is owned by useAuthBackgroundSync. The
 * session generation is captured at effect start and re-checked before every
 * write, because abort cannot cancel an already-settled fetch: a response that
 * settles after logout must not write the profile / USER_EMAIL_KEY or dispatch
 * user-changed for the account that just left.
 */
export function useAuthProfileSync(deps: AuthProfileSyncDeps): void {
  const { isLoggedIn, accessToken } = deps;
  const setUserProfile = useAuthStore((state) => state.setUserProfile);

  useEffect(() => {
    if (isLoggedIn && accessToken) {
      const controller = new AbortController();
      const signal = controller.signal;
      // Session generation captured at effect start: abort only cancels an
      // unsettled fetch, so a response that already settled must be dropped
      // when a logout invalidated the session in the meantime (no post-logout
      // profile / USER_EMAIL_KEY write for the account that just left).
      const mySessionId = getCurrentSessionId();
      void (async () => {
        for (let attempt = 1; attempt <= PROFILE_FETCH_RETRY_MAX; attempt++) {
          try {
            const res = await fetchWithAuth(GOOGLE_USERINFO_URL, {
              headers: authHeaders(accessToken),
              signal,
            });
            if (!res.ok)
              throw new Error(
                `userinfo request failed (${String(res.status)})`,
              );
            const data = (await res.json()) as Record<string, unknown> | null;
            if (data && typeof data.email === "string") {
              // Logout started while the request was in flight -> drop the
              // continuation (abort cannot cancel an already-settled fetch).
              if (mySessionId !== getCurrentSessionId()) return;
              setUserProfile({
                name: typeof data.name === "string" ? data.name : "",
                email: data.email,
                picture: typeof data.picture === "string" ? data.picture : "",
              });
              try {
                localStorage.setItem(USER_EMAIL_KEY, data.email);
              } catch {
                void logAuth("warn", "auth-storage-write-failed");
              }
              window.dispatchEvent(new CustomEvent("user-changed"));
            }
            return;
          } catch (err: unknown) {
            // Abort (unmount / token rotation) exits the retry loop silently:
            // the effect's cleanup semantics must stay untouched.
            if (isAbortError(err)) return;
            // isAbortError does not narrow the type, so fall back to the same
            // name/message extraction used elsewhere (classifyFolderError).
            const message = err instanceof Error ? err.message : String(err);
            const isLastAttempt = attempt === PROFILE_FETCH_RETRY_MAX;
            // Intermediate failures warn (with the attempt number); the final
            // failure keeps the original error-level log.
            if (!isLastAttempt) {
              void logAuth(
                "warn",
                `Profile fetch attempt ${String(attempt)}/${String(PROFILE_FETCH_RETRY_MAX)} failed (best-effort): ${message}`,
              );
            } else {
              void logAuth(
                "error",
                `Failed to fetch user profile (best-effort): ${message}`,
              );
              return;
            }
          }
          // Wait out the backoff between attempts. The caller signal makes an
          // unmount mid-backoff reject immediately (no zombie retry timers) —
          // sleep only ever rejects with the abort reason, so swallowing that
          // rejection here is precisely the stop-on-abort semantics.
          try {
            await sleep(
              PROFILE_FETCH_RETRY_BASE_MS * 2 ** (attempt - 1),
              signal,
            );
          } catch {
            return;
          }
        }
      })();

      return () => {
        controller.abort();
      };
    }
  }, [isLoggedIn, accessToken, setUserProfile]);
}
