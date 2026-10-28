import {
  MY_DRIVE_TAB,
  ROOT_FOLDER_ID,
  VIRTUAL_ROOT_ID,
  VIRTUAL_ROOT_NAME,
} from "../../utils/driveConstants";
import type { RootFolder } from "../../utils/rootFolders";

export type NavHistoryEntry = { id: string; name: string };

// The three store fields a restored navigation lands on. `history` is
// OPTIONAL on purpose: `undefined` means "do not touch the trail" (the
// fallback path keeps whatever trail is live), which is NOT the same as `[]`.
export interface NavTarget {
  currentFolderId: string;
  currentFolderName: string;
  history?: NavHistoryEntry[];
}

// Landing target for the configured root list: the synthetic multi-root node
// when more than one root is configured, otherwise the primary root. The trail
// is left untouched (see NavTarget.history).
export function buildFallbackNavTarget(
  primaryId: string,
  isMulti: boolean,
): NavTarget {
  return {
    currentFolderId: isMulti ? VIRTUAL_ROOT_ID : primaryId,
    currentFolderName: isMulti ? VIRTUAL_ROOT_NAME : MY_DRIVE_TAB,
  };
}

// At the virtual node the trail may only reference the synthetic node or roots
// that are still configured: a removed root id would render a path outside the
// active root set. A virtual marker below another entry (or repeated) cannot
// describe a real trail.
export function sanitizeVirtualHistory(
  history: NavHistoryEntry[],
  activeRootIds: ReadonlySet<string>,
): NavHistoryEntry[] {
  const kept = history.filter(
    (entry) => entry.id === VIRTUAL_ROOT_ID || activeRootIds.has(entry.id),
  );
  const firstVirtual = kept.findIndex((entry) => entry.id === VIRTUAL_ROOT_ID);
  const duplicateVirtual =
    kept.filter((entry) => entry.id === VIRTUAL_ROOT_ID).length > 1;
  return duplicateVirtual || firstVirtual > 0 ? [] : kept;
}

// Keeps only the part of the trail at or below the branch marker: the virtual
// node when present, otherwise the branch root itself. No marker means the
// trail cannot be attributed to this branch.
export function trimHistoryToBranch(
  history: NavHistoryEntry[],
  branchRootId: string | null,
): NavHistoryEntry[] {
  const virtualIndex = history.findIndex(
    (entry) => entry.id === VIRTUAL_ROOT_ID,
  );
  if (virtualIndex !== -1) return history.slice(virtualIndex);
  if (branchRootId !== null) {
    const branchIndex = history.findIndex((entry) => entry.id === branchRootId);
    if (branchIndex !== -1) return history.slice(branchIndex);
  }
  return [];
}

export function verifiedRootName(
  roots: RootFolder[],
  rootId: string,
): string | undefined {
  return roots.find((root) => root.id === rootId)?.name;
}

export interface NavResumeInput {
  /** Verified roots of THIS run — length 1 = single root, >1 = multi root. */
  roots: RootFolder[];
  savedId: string;
  savedName: string;
  savedHistory: NavHistoryEntry[];
  savedRootId?: string | undefined;
}

// Decides where a restored navigation snapshot should land. Pure: no store, no
// localStorage — the hook applies the returned target in the original field
// order (id -> name -> history).
export function computeNavResume(input: NavResumeInput): NavTarget {
  const { roots, savedId, savedName, savedHistory, savedRootId } = input;
  const primaryId = roots[0]?.id ?? ROOT_FOLDER_ID;
  const isMulti = roots.length > 1;
  const activeRootIds = new Set(roots.map((root) => root.id));
  const isActiveRoot = (id: string) => activeRootIds.has(id);
  const fallback = (): NavTarget => ({
    ...buildFallbackNavTarget(primaryId, isMulti),
    history: [],
  });

  if (savedId === VIRTUAL_ROOT_ID) {
    if (isMulti) {
      return {
        currentFolderId: VIRTUAL_ROOT_ID,
        currentFolderName: VIRTUAL_ROOT_NAME,
        history: sanitizeVirtualHistory(savedHistory, activeRootIds),
      };
    }
    // The synthetic node only exists while at least 2 roots are configured.
    return fallback();
  }
  const suspectRoot =
    savedId === ROOT_FOLDER_ID && primaryId !== ROOT_FOLDER_ID;
  if (suspectRoot) {
    return fallback();
  }

  if (isMulti) {
    const savedIdIsRoot = isActiveRoot(savedId);
    if (savedRootId === undefined) {
      // Legacy snapshot: a nested id cannot be attributed to any branch of the
      // active root set.
      if (!savedIdIsRoot) {
        return fallback();
      }
      return {
        currentFolderId: savedId,
        currentFolderName: verifiedRootName(roots, savedId) ?? savedName,
        history: trimHistoryToBranch(savedHistory, savedId),
      };
    }
    const validSavedRoot =
      savedRootId === VIRTUAL_ROOT_ID || isActiveRoot(savedRootId);
    if (!validSavedRoot || (savedIdIsRoot && savedId !== savedRootId)) {
      return fallback();
    }
    return {
      currentFolderId: savedId,
      currentFolderName: savedIdIsRoot
        ? (verifiedRootName(roots, savedId) ?? savedName)
        : savedName,
      history: trimHistoryToBranch(
        savedHistory,
        savedRootId === VIRTUAL_ROOT_ID ? null : savedRootId,
      ),
    };
  }

  // Single root: a real root id must match this root; the virtual node is
  // invalid because it only exists in multi-root mode.
  if (savedRootId !== undefined && savedRootId !== primaryId) {
    return fallback();
  }
  return {
    currentFolderId: savedId,
    currentFolderName:
      savedId === primaryId || savedId === ROOT_FOLDER_ID
        ? MY_DRIVE_TAB
        : savedName,
    history: savedHistory.filter((entry) => entry.id !== VIRTUAL_ROOT_ID),
  };
}
