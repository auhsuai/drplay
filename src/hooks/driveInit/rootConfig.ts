import { MY_DRIVE_TAB } from "../../utils/driveConstants";
import { captureError } from "../../utils/errorLog";
import {
  parseRootFolders,
  rootsSignature,
  type RootFolder,
} from "../../utils/rootFolders";
import {
  ROOT_FOLDER_KEY,
  ROOT_FOLDERS_KEY,
  ROOT_FOLDERS_UPDATED_KEY,
  safeLocalStorageGet,
} from "../../utils/storageKeys";
import { classifyError } from "../useDriveShared";

// Validates the persisted folder-history shape the same way the Dexie branch
// does: an entry survives only when it is an object with a string `id`. The
// type predicate narrows `name` as string even though runtime only checks
// `id` — identical to the inline filter it replaces.
export function parseNavHistory(
  value: unknown,
): { id: string; name: string }[] {
  return Array.isArray(value)
    ? value.filter(
        (x: unknown): x is { id: string; name: string } =>
          typeof x === "object" &&
          x !== null &&
          typeof (x as Record<string, unknown>).id === "string",
      )
    : [];
}

export function readLegacyRootId(
  config: Record<string, unknown>,
): string | null {
  const raw = config.rootFolderId;
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

export function readLegacyRootName(config: Record<string, unknown>): string {
  const raw = config.rootFolderName;
  return typeof raw === "string" && raw.trim() !== ""
    ? raw.trim()
    : MY_DRIVE_TAB;
}

export interface LocalRootSnapshot {
  roots: RootFolder[];
  primary: string | null;
  signature: string;
}

// One snapshot read of the ordered list + legacy primary. logMalformed is
// only true for the initial read: the race guard re-reads this on every
// await boundary and must not spam the log.
//
// Contract: this MUST re-read localStorage on every call (race guard) — never
// cache the snapshot inside this module.
export function readLocalRootState(logMalformed: boolean): LocalRootSnapshot {
  const rawList = safeLocalStorageGet(ROOT_FOLDERS_KEY, "root-folders-read");
  let list: RootFolder[] | null = null;
  if (rawList !== null) {
    try {
      list = parseRootFolders(JSON.parse(rawList));
      if (list === null && logMalformed) {
        void captureError({
          level: "warn",
          source: "useDrive",
          message: "root-folders-parse: invalid localStorage root folder list",
        });
      }
    } catch (e: unknown) {
      list = null;
      if (logMalformed) {
        void captureError({
          level: "warn",
          source: "useDrive",
          message: `root-folders-parse: corrupt localStorage root folder list, ${classifyError(e)}`,
        });
      }
    }
  }
  const primary = safeLocalStorageGet(ROOT_FOLDER_KEY, "root-folder-read");
  const roots = list ?? (primary ? [{ id: primary, name: MY_DRIVE_TAB }] : []);
  return {
    roots,
    primary,
    signature: `${rootsSignature(roots)}|${primary ?? ""}`,
  };
}

// Local commit marker (epoch ms): when it is NEWER than the remote updatedAt,
// the local list is a commit whose cloud save has not landed yet (or failed)
// and must win over the stale remote config. 0 when absent/corrupt.
export function readLocalVersionMarker(): number {
  const localUpdatedAtRaw = safeLocalStorageGet(
    ROOT_FOLDERS_UPDATED_KEY,
    "root-folders-updated-read",
  );
  const parsedLocalUpdatedAt =
    localUpdatedAtRaw === null ? Number.NaN : Number(localUpdatedAtRaw);
  return Number.isFinite(parsedLocalUpdatedAt) ? parsedLocalUpdatedAt : 0;
}
