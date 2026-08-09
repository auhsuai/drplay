import { captureError } from "./errorLog";
import { authHeaders } from "./driveFiles";
import { classifyDriveError, driveFetch } from "./driveHttp";
import { DRIVE_MODULE } from "./driveTypes";
import type { DriveStorageQuota } from "./driveTypes";

// Google Drive "about" resource quota fields
// (developers.google.com/workspace/drive/api/reference/rest/v3/about). All
// fields are int64 byte counts delivered as JSON strings; "limit" is ABSENT
// for accounts with unlimited storage (e.g. Workspace pooled quota), so the
// UI must treat a missing limit as unlimited rather than 0.
const QUOTA_API_URL = "https://www.googleapis.com/drive/v3/about";
const QUOTA_FIELDS = "storageQuota";

// Parse a Drive int64 field that arrives as a JSON string (or already a
// number). Returns null for anything non-numeric so callers can distinguish
// "absent" from "0".
function parseByteCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Fetch the signed-in user's Drive storage quota for the sidebar display.
 * Quota is non-critical chrome: any failure returns null (never throws) and
 * logs at 'warn' so the UI simply hides the section — a quota outage must
 * never crash or block the sidebar. A missing `limit` means unlimited storage
 * (Workspace pooled quota).
 * @param token Drive access token.
 * @returns The quota breakdown, or null on failure/malformed payload.
 */
export async function getDriveStorageQuota(
  token: string,
): Promise<DriveStorageQuota | null> {
  try {
    const response = await driveFetch(
      `${QUOTA_API_URL}?fields=${QUOTA_FIELDS}`,
      {
        headers: authHeaders(token),
      },
    );
    if (!response.ok) {
      await captureError({
        level: "warn",
        source: DRIVE_MODULE,
        message: `get-storage-quota-failed (status=${String(response.status)})`,
      });
      return null;
    }
    const data = (await response.json()) as {
      storageQuota?: Record<string, unknown>;
    } | null;
    const quota = data?.storageQuota;
    if (!quota) {
      await captureError({
        level: "warn",
        source: DRIVE_MODULE,
        message: "get-storage-quota-malformed-response (missing storageQuota)",
      });
      return null;
    }
    const limit = parseByteCount(quota.limit);
    const usage = parseByteCount(quota.usage);
    const usageInDrive = parseByteCount(quota.usageInDrive);
    const usageInDriveTrash = parseByteCount(quota.usageInDriveTrash);
    // The three usage fields are mandatory on a valid storageQuota object;
    // a payload missing any of them is malformed → treat as failure, hide UI.
    if (usage === null || usageInDrive === null || usageInDriveTrash === null) {
      await captureError({
        level: "warn",
        source: DRIVE_MODULE,
        message: "get-storage-quota-malformed-response (missing usage field)",
      });
      return null;
    }
    return { limit, usage, usageInDrive, usageInDriveTrash };
  } catch (err) {
    await captureError({
      level: "warn",
      source: DRIVE_MODULE,
      message: `get-storage-quota-failed: ${classifyDriveError(err)}`,
    });
    return null;
  }
}
