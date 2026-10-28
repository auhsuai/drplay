import { getAppConfig, FOLDER_MIME } from "../../utils/driveApi";
import { getValidToken, fetchWithAuth } from "../../utils/apiClient";
import { authHeaders, DRIVE_FILES_URL } from "../../utils/driveFiles";
import {
  parseRootFolders,
  rootsSignature,
  type RootFolder,
} from "../../utils/rootFolders";
import { captureError } from "../../utils/errorLog";
import { classifyError } from "../useDriveShared";
import { readLegacyRootId, readLegacyRootName } from "./rootConfig";
import { persistRootListLocally } from "./rootCache";

// Exactly the fields the root verification needs: the real name (refresh),
// the folder mimeType and driveId (Shared Drive folders are rejected).
const VERIFY_FIELDS = "id,name,driveId,mimeType";

// ─── Step 2: authoritative root list (pure) ────────────────────────────────

export interface AuthoritativeRootsInput {
  remoteConfig: Record<string, unknown> | null;
  localRoots: RootFolder[];
  /** Epoch-ms of the last local commit; 0 when absent/corrupt. */
  localUpdatedAt: number;
}

export interface AuthoritativeRootWarning {
  code: "config-primary-mismatch" | "config-root-folders-invalid";
  message: string;
}

export interface AuthoritativeRootsResult {
  proposed: RootFolder[];
  warnings: AuthoritativeRootWarning[];
}

// Cloud list is canonical when valid; otherwise migrate the legacy single
// root. A missing remote config keeps whatever is stored locally. The branch
// order below is behaviour-critical (see the decision table in the plan).
export function selectAuthoritativeRoots(
  input: AuthoritativeRootsInput,
): AuthoritativeRootsResult {
  const { remoteConfig, localRoots, localUpdatedAt } = input;
  const warnings: AuthoritativeRootWarning[] = [];
  if (remoteConfig === null) {
    return { proposed: localRoots, warnings };
  }
  const remoteUpdatedAt =
    typeof remoteConfig.updatedAt === "number" &&
    Number.isFinite(remoteConfig.updatedAt)
      ? remoteConfig.updatedAt
      : 0;
  const localIsNewer =
    localRoots.length > 0 && localUpdatedAt > remoteUpdatedAt;
  const localIsNewerThanLegacy = localRoots.length > 0 && localUpdatedAt > 0;
  let proposed: RootFolder[];
  if (remoteConfig.rootFolders !== undefined) {
    const remoteRoots = parseRootFolders(remoteConfig.rootFolders);
    if (remoteRoots !== null) {
      if (localIsNewer) {
        // GAP-3: this install committed after the remote config was written
        // (or its cloud save never landed). The stale remote list — and its
        // possibly-stale legacy primary — must not overwrite the user's newer
        // local choice.
        proposed = localRoots;
      } else {
        proposed = remoteRoots;
        const remotePrimary = remoteRoots[0];
        if (
          remotePrimary !== undefined &&
          remoteConfig.rootFolderId !== remotePrimary.id
        ) {
          // Every writer keeps the legacy scalar in sync with index 0; a
          // mismatch means the scalar is stale, so the list wins and its first
          // entry remains the primary.
          warnings.push({
            code: "config-primary-mismatch",
            message: "config-primary-mismatch: using rootFolders[0]",
          });
        }
      }
    } else {
      warnings.push({
        code: "config-root-folders-invalid",
        message:
          "config-root-folders-invalid: falling back to the legacy root id",
      });
      const legacyId = readLegacyRootId(remoteConfig);
      proposed = legacyId
        ? [{ id: legacyId, name: readLegacyRootName(remoteConfig) }]
        : localRoots;
    }
  } else if (localIsNewerThanLegacy) {
    // A commit on this install is newer than a legacy-only remote document:
    // keep the local list instead of migrating backwards.
    proposed = localRoots;
  } else {
    const legacyId = readLegacyRootId(remoteConfig);
    proposed = legacyId
      ? [{ id: legacyId, name: readLegacyRootName(remoteConfig) }]
      : localRoots;
  }
  return { proposed, warnings };
}

// ─── Step 3: verify every root (async, cancellation-gated) ─────────────────

export interface VerifyRootsInput {
  proposed: RootFolder[];
  token: string;
  signal: AbortSignal;
  /** Reads the effect's mutable cancellation flag — never a captured value. */
  isCancelled: () => boolean;
  /** Reads the local-commit signature guard — never a captured value. */
  rootChangedByUser: () => boolean;
  /** True when this effect re-ran on an already-hydrated mount. */
  isReInit: boolean;
  /** `rootChanged` as computed before the loop (signature of proposed). */
  rootChangedBeforeVerify: boolean;
}

export type VerifyOutcome =
  // Effect cleaned up: write nothing, log nothing.
  | { kind: "cancelled" }
  // User committed a new root list mid-request: write nothing.
  | { kind: "user-changed" }
  // Re-init + transient failure + unchanged roots: keep the live roots and
  // end initApp (do NOT re-apply nav).
  | { kind: "keep-previous" }
  // First-init transient failure: keep localRoots, continue the apply branch.
  | { kind: "transient" }
  | { kind: "verified"; verified: RootFolder[]; invalidIds: string[] };

// Verify EVERY root in order (all-or-nothing). A single bad entry must not
// silently adopt a partial list: only the verified primary may survive as the
// fallback. A transient failure (network/timeout/5xx) must never invalidate a
// stored configuration: first-init keeps the local roots instead of flashing
// the setup gate, and a re-init keeps the live ones. 4xx and shape errors stay
// definitive.
export async function verifyRoots(
  input: VerifyRootsInput,
): Promise<VerifyOutcome> {
  const {
    proposed,
    token,
    signal,
    isCancelled,
    rootChangedByUser,
    isReInit,
    rootChangedBeforeVerify,
  } = input;
  const verified: RootFolder[] = [];
  const invalidIds: string[] = [];
  for (const root of proposed) {
    const verifyUrl = `${DRIVE_FILES_URL}/${encodeURIComponent(root.id)}?fields=${VERIFY_FIELDS}`;
    let verifyRes: Response;
    try {
      verifyRes = await fetchWithAuth(verifyUrl, {
        headers: authHeaders(token),
        // Timeout is guaranteed by fetchWithAuth itself (15s default merged
        // with the caller signal via AbortSignal.any).
        signal,
      });
    } catch (e: unknown) {
      // Effect cleanup aborts the request: expected, not a fault.
      if (isCancelled()) return { kind: "cancelled" };
      if (rootChangedByUser()) return { kind: "user-changed" };
      if (isReInit && !rootChangedBeforeVerify) {
        void captureError({
          level: "warn",
          source: "useDrive",
          message: `reverify-transient: keeping previous roots (${classifyError(e)})`,
        });
        return { kind: "keep-previous" };
      }
      void captureError({
        level: "warn",
        source: "useDrive",
        message: `verify-roots-transient: keeping stored roots (${classifyError(e)})`,
      });
      return { kind: "transient" };
    }
    if (isCancelled()) return { kind: "cancelled" };
    if (rootChangedByUser()) return { kind: "user-changed" };
    if (!verifyRes.ok) {
      if (verifyRes.status >= 500) {
        if (isReInit && !rootChangedBeforeVerify) {
          // B12-1: a transient (5xx) re-verify failure during a token rotation
          // keeps the previous roots — nulling them would open the folder gate
          // mid-session.
          void captureError({
            level: "warn",
            source: "useDrive",
            message: `reverify-transient: keeping previous roots (HTTP ${String(verifyRes.status)})`,
          });
          return { kind: "keep-previous" };
        }
        void captureError({
          level: "warn",
          source: "useDrive",
          message: `verify-roots-transient: keeping stored roots (HTTP ${String(verifyRes.status)})`,
        });
        return { kind: "transient" };
      }
      void captureError({
        level: "warn",
        source: "useDrive",
        message: `verify-root-inaccessible: dropping root ${root.id}`,
      });
      invalidIds.push(root.id);
      continue;
    }
    let verifyData: unknown;
    try {
      verifyData = await verifyRes.json();
    } catch (e: unknown) {
      void captureError({
        level: "warn",
        source: "useDrive",
        message: `verify-root-parse: dropping root ${root.id}, ${classifyError(e)}`,
      });
      invalidIds.push(root.id);
      continue;
    }
    if (isCancelled()) return { kind: "cancelled" };
    if (rootChangedByUser()) return { kind: "user-changed" };
    if (
      typeof verifyData !== "object" ||
      verifyData === null ||
      (verifyData as { mimeType?: unknown }).mimeType !== FOLDER_MIME
    ) {
      void captureError({
        level: "warn",
        source: "useDrive",
        message: `verify-root-not-folder: dropping root ${root.id}`,
      });
      invalidIds.push(root.id);
      continue;
    }
    const folder = verifyData as {
      name?: unknown;
      driveId?: unknown;
    };
    if (folder.driveId) {
      void captureError({
        level: "warn",
        source: "useDrive",
        message: `verify-root-shared-drive: dropping root ${root.id}`,
      });
      invalidIds.push(root.id);
      continue;
    }
    const rawName = folder.name;
    const verifiedName =
      typeof rawName === "string" && rawName.trim() !== ""
        ? rawName.trim()
        : root.name;
    verified.push({ id: root.id, name: verifiedName });
  }
  return { kind: "verified", verified, invalidIds };
}

// ─── Step 4: post-verify fallback decision (pure) ──────────────────────────

export interface FinalizeRootsInput {
  proposed: RootFolder[];
  verified: RootFolder[];
  invalidIds: string[];
  localRoots: RootFolder[];
  /** A transient failure short-circuits the whole decision (keep local). */
  transientFailure: boolean;
}

export interface FinalizeRootsResult {
  roots: RootFolder[];
  /** signature(roots) !== signature(localRoots) — gates wipe + nav reset. */
  finalChanged: boolean;
  /** True when the reduced list must be persisted locally (GAP-2). */
  persistReduced: boolean;
  /** Warnings to report verbatim (order matters for log fidelity). */
  messages: string[];
}

export function finalizeVerifiedRoots(
  input: FinalizeRootsInput,
): FinalizeRootsResult {
  const { proposed, verified, invalidIds, localRoots, transientFailure } =
    input;
  if (transientFailure) {
    return {
      roots: localRoots,
      finalChanged: false,
      persistReduced: false,
      messages: [],
    };
  }
  const messages: string[] = [];
  let roots: RootFolder[];
  let persistReduced = false;
  if (verified.length === proposed.length) {
    roots = verified;
  } else {
    persistReduced = true;
    const verifiedPrimary = verified[0];
    const proposedPrimary = proposed[0];
    if (
      verifiedPrimary !== undefined &&
      proposedPrimary !== undefined &&
      verifiedPrimary.id === proposedPrimary.id
    ) {
      // All-or-nothing fallback: keep exactly the verified primary.
      roots = [verifiedPrimary];
      messages.push(
        `verify-roots-partial: keeping primary, dropping [${invalidIds.join(", ")}]`,
      );
    } else {
      roots = [];
    }
  }
  // Final decision AFTER verification: a dropped secondary can reduce the
  // remote proposal back to the stored list, in which case the cache wipe/nav
  // reset must NOT run.
  const finalChanged = rootsSignature(roots) !== rootsSignature(localRoots);
  return { roots, finalChanged, persistReduced, messages };
}

// ─── Step 5: async coordinator ─────────────────────────────────────────────

export interface ReconcileRemoteRootsInput {
  signal: AbortSignal;
  localRoots: RootFolder[];
  localUpdatedAt: number;
  isReInit: boolean;
  isCancelled: () => boolean;
  rootChangedByUser: () => boolean;
}

export type ReconcileRemoteRootsOutcome =
  | { kind: "cancelled" }
  | { kind: "user-changed" }
  | { kind: "keep-previous" }
  // `config-failed` → the caller must null the roots (sync-config-failed).
  | { kind: "config-failed" }
  | { kind: "resolved"; roots: RootFolder[]; rootChanged: boolean };

// Never throws for cancellation or a failed sync: every path is an outcome.
// The hook maps `cancelled` / `user-changed` / `keep-previous` to an early
// return so no state is written after the effect was torn down.
export async function reconcileRemoteRoots(
  input: ReconcileRemoteRootsInput,
): Promise<ReconcileRemoteRootsOutcome> {
  const {
    signal,
    localRoots,
    localUpdatedAt,
    isReInit,
    isCancelled,
    rootChangedByUser,
  } = input;
  // Tracks whether this run already adopted a different root list; the outer
  // catch must not convert a post-adopt failure into "keep previous roots".
  let rootChanged = false;
  try {
    const freshToken = await getValidToken();
    if (isCancelled()) return { kind: "cancelled" };
    if (rootChangedByUser()) return { kind: "user-changed" };
    if (!freshToken) {
      return { kind: "resolved", roots: [], rootChanged: false };
    }
    const remoteConfig = await getAppConfig(freshToken, signal);
    if (isCancelled()) return { kind: "cancelled" };
    if (rootChangedByUser()) return { kind: "user-changed" };

    const selected = selectAuthoritativeRoots({
      remoteConfig,
      localRoots,
      localUpdatedAt,
    });
    for (const warning of selected.warnings) {
      void captureError({
        level: "warn",
        source: "useDrive",
        message: warning.message,
      });
    }
    const proposed = selected.proposed;
    rootChanged = rootsSignature(proposed) !== rootsSignature(localRoots);

    const outcome = await verifyRoots({
      proposed,
      token: freshToken,
      signal,
      isCancelled,
      rootChangedByUser,
      isReInit,
      rootChangedBeforeVerify: rootChanged,
    });
    if (outcome.kind === "cancelled") return { kind: "cancelled" };
    if (outcome.kind === "user-changed") return { kind: "user-changed" };
    if (outcome.kind === "keep-previous") return { kind: "keep-previous" };

    const transientFailure = outcome.kind === "transient";
    const final = finalizeVerifiedRoots({
      proposed,
      verified: transientFailure ? [] : outcome.verified,
      invalidIds: transientFailure ? [] : outcome.invalidIds,
      localRoots,
      transientFailure,
    });
    for (const message of final.messages) {
      void captureError({
        level: "warn",
        source: "useDrive",
        message,
      });
    }
    rootChanged = final.finalChanged;
    if (
      !final.finalChanged &&
      final.persistReduced &&
      outcome.kind === "verified"
    ) {
      const verifiedPrimaryRoot = final.roots[0];
      if (verifiedPrimaryRoot !== undefined) {
        // Re-check right before writing: a user commit may have landed since
        // the last in-loop check.
        if (isCancelled()) return { kind: "cancelled" };
        if (rootChangedByUser()) return { kind: "user-changed" };
        // GAP-2: persist the reduced verified list locally so the next boot
        // prefers it instead of re-verifying and dropping the same root
        // forever. NO cloud write: a possibly transient 403 must not destroy a
        // valid remote config.
        persistRootListLocally(verifiedPrimaryRoot.id, final.roots);
        void captureError({
          level: "warn",
          source: "useDrive",
          message: `verify-roots-partial-persist: keeping verified roots locally, dropping [${outcome.invalidIds.join(", ")}]`,
        });
      }
    }
    return {
      kind: "resolved",
      roots: final.roots,
      rootChanged: final.finalChanged,
    };
  } catch (e: unknown) {
    if (isCancelled()) return { kind: "cancelled" };
    if (isReInit && !rootChanged) {
      // B12-1: a transient failure (network/timeout) during a re-init with
      // unchanged roots must keep the previous roots instead of opening the
      // folder gate mid-session.
      void captureError({
        level: "warn",
        source: "useDrive",
        message: `reverify-transient: keeping previous roots (${classifyError(e)})`,
      });
      return { kind: "keep-previous" };
    }
    void captureError({
      level: "error",
      source: "useDrive",
      message: `sync-config-failed: ${classifyError(e)}`,
    });
    return { kind: "config-failed" };
  }
}
