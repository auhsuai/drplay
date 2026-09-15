import { useEffect, useRef } from "react";
import { getValidToken } from "../utils/apiClient";
import { captureError } from "../utils/errorLog";
import { ACCESS_TOKEN_KEY, safeLocalStorageGet } from "../utils/storageKeys";

const SW_SCOPE = "/sw.js";
const MSG_UPDATE_TOKEN = "UPDATE_TOKEN";
const EVENT_TOKEN_UPDATED = "token-updated";
const EVENT_SW_TOKEN_EXPIRED = "SW_TOKEN_EXPIRED";

// postMessage to a service worker can throw (e.g. InvalidStateError when the
// worker is redundant); a token push must never break the SW lifecycle, so
// failures are logged and swallowed.
function safePost(
  target: ServiceWorker | null | undefined,
  message: { type: string; token?: string },
): void {
  if (!target) return;
  try {
    target.postMessage(message);
  } catch (e: unknown) {
    void captureError({
      level: "warn",
      source: "useServiceWorker",
      message: `sw-post-failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

// Token storage state (M1/M2): the refresh token is NOT in localStorage
// anymore — it lives in the OS credential vault (Windows Credential Manager
// via keyring, src-tauri/src/token_store.rs); the only localStorage copy is a
// degraded fallback kept (and logged) when a keyring write fails. The
// short-lived access token (~1h) intentionally stays in localStorage: its
// exposure window is bounded and keeping it client-side gives the SW/worker
// fast, synchronous access without a backend round-trip (rationale in
// token_store.rs). NOTE: @tauri-apps/plugin-store is NOT encrypted (it just
// persists state to a file), so "migrating" there would not improve security —
// any future hardening should go through the OS keychain/DPAPI/Stronghold.
export function useServiceWorker(token?: string | null) {
  // The lifecycle effect below is MOUNT-ONLY ([]): register() resolves to the
  // SAME registration object on every call (W3C SW spec object map), so a
  // token-refresh re-run used to stack updatefound listeners on one EventTarget.
  // The token is read through a ref instead, so every push still carries the
  // LATEST token (never the closure value captured when the effect mounted).
  const tokenRef = useRef(token);
  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    // localStorage can throw (SecurityError in privacy modes) — the guarded
    // read logs `sw-access-token-read-failed` and yields null (no push), same
    // semantics as the previous `token ?? localStorage.getItem` fallback.
    const getToken = () =>
      tokenRef.current ??
      safeLocalStorageGet(
        ACCESS_TOKEN_KEY,
        "sw-access-token-read",
        "useServiceWorker",
      );

    let reg: ServiceWorkerRegistration | null = null;
    let onUpdateFound: (() => void) | null = null;
    let cancelled = false;

    navigator.serviceWorker
      .register(SW_SCOPE)
      .then((registration) => {
        // Unmount may win the race against register(): attaching here would
        // leak the listener because cleanup already ran.
        if (cancelled) return;
        reg = registration;

        const t = getToken();
        if (t) {
          // The just-registered worker may still be installing; navigator.serviceWorker.ready
          // resolves only once the registration has an ACTIVE worker (MDN
          // ServiceWorkerContainer.ready), so this postMessage never hits a
          // non-active worker and cannot throw a mislabeled "registration failed".
          navigator.serviceWorker.ready
            .then((readyReg) => {
              safePost(readyReg.active, {
                type: MSG_UPDATE_TOKEN,
                token: t,
              });
            })
            .catch((err: unknown) => {
              void captureError({
                level: "warn",
                source: "useServiceWorker",
                message: `SW ready failed: ${err instanceof Error ? err.message : String(err)}`,
              });
            });
        }

        onUpdateFound = () => {
          const newWorker = registration.installing;
          const currentToken = getToken();
          if (newWorker && currentToken) {
            newWorker.addEventListener("statechange", () => {
              if (newWorker.state === "activated") {
                const freshToken = getToken();
                if (freshToken) {
                  safePost(newWorker, {
                    type: MSG_UPDATE_TOKEN,
                    token: freshToken,
                  });
                }
              }
            });
          }
        };
        registration.addEventListener("updatefound", onUpdateFound);
      })
      .catch((err: unknown) => {
        void captureError({
          level: "error",
          source: "useServiceWorker",
          message: `SW Registration failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      });

    const handleControllerChange = () => {
      const t = getToken();
      if (t && navigator.serviceWorker.controller) {
        safePost(navigator.serviceWorker.controller, {
          type: MSG_UPDATE_TOKEN,
          token: t,
        });
      }
    };
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      handleControllerChange,
    );
    return () => {
      cancelled = true;
      // reg stays null while register() is still in flight — nothing to remove
      // (the cancelled flag above prevents the late attach).
      if (reg !== null && onUpdateFound !== null) {
        reg.removeEventListener("updatefound", onUpdateFound);
      }
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        handleControllerChange,
      );
    };
  }, []);

  // Push the current access token to the SW whenever it changes (login,
  // refresh, restore, logout). The SW holds the token in its own memory and
  // only learns it via UPDATE_TOKEN messages; the lifecycle pushes above run
  // BEFORE a fresh login completes (register/claim finish while OAuth is still
  // in flight), so without this watcher a newly logged-in user's first play
  // hits "Missing Token in SW" (401) and the <audio> element fails with
  // NotSupportedError. An empty token (logout) clears the SW's stale copy so a
  // later different account cannot reuse it. Duplicates with the lifecycle
  // pushes are harmless: the SW's UPDATE_TOKEN handler is idempotent.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.ready
      .then((reg) => {
        const target = navigator.serviceWorker.controller ?? reg.active;
        if (target)
          safePost(target, { type: MSG_UPDATE_TOKEN, token: token ?? "" });
      })
      .catch((err: unknown) => {
        void captureError({
          level: "warn",
          source: "useServiceWorker",
          message: `sw-token-push-failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
  }, [token]);

  useEffect(() => {
    const handleTokenUpdated = (ev: Event) => {
      const detail = (ev as CustomEvent<{ token?: unknown } | null>).detail;
      const t = detail?.token;
      if (navigator.serviceWorker.controller && typeof t === "string") {
        safePost(navigator.serviceWorker.controller, {
          type: MSG_UPDATE_TOKEN,
          token: t,
        });
      }
    };
    window.addEventListener(EVENT_TOKEN_UPDATED, handleTokenUpdated);
    return () => {
      window.removeEventListener(EVENT_TOKEN_UPDATED, handleTokenUpdated);
    };
  }, []);

  // A 401 from /drive-stream/ means the token inside the SW is stale (SW
  // retries once after a refresh). Force a refresh; on success apiClient
  // dispatches 'token-updated' and the listener above pushes UPDATE_TOKEN
  // back, which resolves the SW's retry wait. Failure is non-fatal: the SW
  // falls back to the original 401 response.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const handleSwMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown } | null;
      if (!data || data.type !== EVENT_SW_TOKEN_EXPIRED) return;
      getValidToken(true).catch((e: unknown) => {
        void captureError({
          level: "warn",
          source: "useServiceWorker",
          message: `sw-token-expired-refresh-failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      });
    };
    navigator.serviceWorker.addEventListener("message", handleSwMessage);
    return () => {
      navigator.serviceWorker.removeEventListener("message", handleSwMessage);
    };
  }, []);
}
