// Ordered list of the user's root folders. Index 0 is the primary root — the
// library scope and the default landing folder. A configured list always has
// at least 1 entry and at most MAX_ROOT_FOLDERS.
export type RootFolder = {
  id: string;
  name: string;
};

export const MAX_ROOT_FOLDERS = 5;

// Runtime validation is mandatory here: the value comes from localStorage or
// an untyped remote JSON payload, so the TypeScript type proves nothing.
// Normalizes id/name by trimming and keeps only {id, name}. Any invalid shape —
// not an array, out-of-range length, non-object entry, blank/missing id or
// name, duplicate id — returns null (never throws, never an empty array).
function parseRootFolder(value: unknown): RootFolder | null {
  if (typeof value !== "object" || value === null) return null;
  const { id, name } = value as { id?: unknown; name?: unknown };
  if (typeof id !== "string" || typeof name !== "string") return null;
  const trimmedId = id.trim();
  const trimmedName = name.trim();
  if (trimmedId === "" || trimmedName === "") return null;
  return { id: trimmedId, name: trimmedName };
}

export function parseRootFolders(value: unknown): RootFolder[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length < 1 || value.length > MAX_ROOT_FOLDERS) return null;
  const roots: RootFolder[] = [];
  const seenIds = new Set<string>();
  for (const entry of value) {
    const root = parseRootFolder(entry);
    if (root === null || seenIds.has(root.id)) return null;
    seenIds.add(root.id);
    roots.push(root);
  }
  return roots;
}

// Stable identity for the whole ordered root list, used by the race guard.
// Derived from ids only (names can change when the verify API refreshes them),
// so renames do not invalidate in-flight work.
export function rootsSignature(roots: RootFolder[]): string {
  return JSON.stringify(roots.map((root) => root.id));
}
