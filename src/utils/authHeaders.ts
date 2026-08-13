// Header builders shared by the main thread (driveFiles callers) and the
// proSync worker (driveFetch). This module is dependency-free on purpose:
// the worker must not pull in tauri/localStorage/window-bound modules, so
// only pure string formatting lives here. Keeping "Bearer <token>" (and the
// JSON content type) in one place stops the two sides from drifting.

export function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export function authJsonHeaders(token: string): Record<string, string> {
  return { ...authHeaders(token), "Content-Type": "application/json" };
}
