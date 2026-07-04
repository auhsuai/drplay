const authSessionIdRef = { current: 0 };

export function invalidateCurrentSession() {
  authSessionIdRef.current += 1;
}

export function getCurrentSessionId() {
  return authSessionIdRef.current;
}
