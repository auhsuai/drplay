import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  getDriveStorageQuota,
  type DriveStorageQuota,
} from "../../utils/driveApi";
import { formatBytes } from "../../utils/formatBytes";
import { captureError } from "../../utils/errorLog";

const SIDEBAR_MODULE = "Sidebar";
// Storage bar width (expanded) — matches the FULL NavItem hover-row extent:
// sidebar w-64 (256px) − nav px-4 right (16px, row hover right edge at 240px)
// − storage px-4 left (16px) − track ml-3 (12px) = 212px. The row's hover
// background spans its whole px-3 row box, so aligning to that (not the
// icon+text content) makes the bar's right edge line up with the hover zone
// of the Home/My Drive rows above. A fixed width (instead of `flex-1`/max-w)
// is required so the collapsed <-> expanded width transition can animate
// smoothly between two concrete values.
const STORAGE_BAR_WIDTH_CLASS = "w-[212px]";

// Usage fraction at which the quota bar fill and the usage text switch from
// blue to red. Mirrors Google's behavior of flagging accounts that cross 80%
// of their storage limit (Stanford UIT docs:
// uit.stanford.edu/project/google-workspace-optimization/understanding-google-
// storage-limit-alerts); 0.8 = 80% of the account limit. Exactly at the
// threshold is still treated as safe (<= threshold, not <).
const STORAGE_WARNING_THRESHOLD = 0.8;

interface StorageQuotaCardProps {
  token?: string | null | undefined;
  isSidebarOpen: boolean;
}

export function StorageQuotaCard({
  token,
  isSidebarOpen,
}: StorageQuotaCardProps) {
  const { t } = useTranslation();
  const [quota, setQuota] = useState<DriveStorageQuota | null>(null);

  // Reset quota when the token goes away (logout) — adjusted during render
  // (React "adjusting state during render" pattern) instead of in the effect,
  // avoiding react-hooks/set-state-in-effect.
  if (!token && quota !== null) setQuota(null);

  // Storage quota: only for a logged-in user (token present). Re-fetched on
  // 'user-changed' (account switch re-keys Drive storage entirely). Failure
  // hides the section silently — getDriveStorageQuota never throws by
  // contract; the catch is defensive so a future regression cannot crash the
  // sidebar.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const loadQuota = () => {
      void getDriveStorageQuota(token)
        .then((data) => {
          if (!cancelled) setQuota(data);
        })
        .catch((err: unknown) => {
          void captureError({
            level: "warn",
            source: SIDEBAR_MODULE,
            message: `storage-quota-failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        });
    };
    loadQuota();
    window.addEventListener("user-changed", loadQuota);
    return () => {
      cancelled = true;
      window.removeEventListener("user-changed", loadQuota);
    };
  }, [token]);

  const quotaAvailable = quota && quota.limit !== null && quota.limit > 0;
  const usageFraction = quotaAvailable
    ? quota.usageInDrive / (quota.limit as number)
    : 0;
  const isOverThreshold = usageFraction > STORAGE_WARNING_THRESHOLD;
  // Two-segment fill: the safe zone (0 → threshold) stays blue, and only the
  // excess above the threshold turns red; the remaining track stays gray.
  // Clamped so the segments never exceed the track width, even when usage is
  // past the account limit (the two segments cap at 100% total).
  const usagePercent = quotaAvailable
    ? Math.min(100, Math.round(usageFraction * 100))
    : 0;
  const thresholdPercent = quotaAvailable
    ? Math.round(STORAGE_WARNING_THRESHOLD * 100)
    : 0;
  const safeZonePercent = Math.min(usagePercent, thresholdPercent);
  const excessPercent = Math.max(0, usagePercent - thresholdPercent);

  return (
    <>
      {token && quota && (isSidebarOpen || quota.limit !== null) && (
        <div
          data-testid="storage-quota"
          title={
            !isSidebarOpen && quota.limit !== null
              ? `${formatBytes(quota.usageInDrive)} / ${formatBytes(quota.limit)}`
              : undefined
          }
          className="flex items-center transition-all duration-300 px-4 pb-4"
        >
          <div>
            {quota.limit !== null && (
              <div
                data-testid="storage-quota-track"
                className={`h-1.5 bg-gray-200 dark:bg-[#2A2A2A] rounded-full overflow-hidden transition-all duration-300 ease-in-out ml-3 flex items-stretch ${isSidebarOpen ? STORAGE_BAR_WIDTH_CLASS : "w-11"}`}
              >
                <div
                  data-testid="storage-quota-bar"
                  className={`h-full bg-brand-primary ${excessPercent > 0 ? "rounded-l-full" : "rounded-full"}`}
                  style={{ width: `${String(safeZonePercent)}%` }}
                />
                {excessPercent > 0 && (
                  <div
                    data-testid="storage-quota-bar-red"
                    className="h-full bg-red-500 rounded-r-full"
                    style={{ width: `${String(excessPercent)}%` }}
                  />
                )}
              </div>
            )}
            {/* Always mounted to reserve fixed space below the track (mt-1.5 + h-4),
                so the track never jumps when the text appears/disappears. Collapsed:
                invisible (opacity-0). Enter and exit are both pure CSS TRANSITIONS
                (NOT tw-animate keyframes — the old animate-out started from the
                element's current computed style, which was already opacity-0 from
                the static class, so the whole exit ran invisible; the old
                animate-in used a different keyframe mechanism, so enter and exit
                felt mismatched). The same transition-all (present in BOTH states
                so the browser reads it as the before-change style) fades the text
                in while gliding down from 8px above (opacity-0 -translate-y-2 →
                opacity-100 translate-y-0) over 300ms, easing in-out, and runs
                SIMULTANEOUSLY with the track width transition (no delay) — exit is
                the exact reverse, so both directions share the same easing and
                feel. The 300ms is synced with the track's duration-300 (was
                150ms: the text finished fading while the track/sidebar kept
                growing for another 150ms → visible stutter on expand). Note:
                overflow-hidden is ALWAYS present, not only when collapsed — on
                expand the wrapper is still narrow (track at w-11, growing), and
                without clipping the text wraps to 2 lines and spills out of the
                fixed h-4 over the section below (the reported short jank).
                Limitation: the wrapper's width is squeezed by the shrinking
                track (no width transition on this element), so the slide is
                accompanied by a horizontal collapse of the clipped area. */}
            <div
              data-testid="storage-quota-text"
              className={`mt-1.5 h-4 ml-3 overflow-hidden transition-all duration-300 ease-in-out ${isSidebarOpen ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-2"}`}
            >
              {quota.limit !== null ? (
                <p className="text-xs">
                  <span
                    data-testid="storage-quota-usage"
                    className={
                      isOverThreshold ? "text-red-500" : "text-brand-primary"
                    }
                  >
                    {formatBytes(quota.usageInDrive)}
                  </span>
                  <span
                    data-testid="storage-quota-limit"
                    className="text-gray-500 dark:text-gray-400"
                  >
                    {" / "}
                    {formatBytes(quota.limit)}
                  </span>
                </p>
              ) : (
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {t("sidebar.storage_unlimited")}{" "}
                  {formatBytes(quota.usageInDrive)}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
