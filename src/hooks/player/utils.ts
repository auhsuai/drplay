export const playRequestIdRef = { current: 0 };

export function beginPlaybackIntent(): number {
  return ++playRequestIdRef.current;
}

export function isIntentStale(myId: number): boolean {
  return myId !== playRequestIdRef.current;
}

export function classifyPlayerError(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  if (typeof err === "string") return { name: "Error", message: err };
  return { name: "UnknownError", message: "Unknown error" };
}
