import { CloudOff, FileWarning, WifiOff } from "lucide-react";
import { createPortal } from "react-dom";

interface ErrorInfo {
  code: string;
  message: string;
}

export interface ErrorToastProps {
  errorInfo: ErrorInfo | null;
  errorText: string | null;
}

function ErrorIcon({
  type,
  className = "w-5 h-5 shrink-0",
}: {
  type: string;
  className?: string;
}) {
  const Icon =
    type === "rate_limited" ||
    type === "drive_quota_exceeded" ||
    type === "download_quota"
      ? CloudOff
      : type === "file_deleted" ||
          type === "format_error" ||
          type === "access_denied"
        ? FileWarning
        : WifiOff;
  return <Icon className={`${className} text-brand-primary`} />;
}

export function ErrorToast({ errorInfo, errorText }: ErrorToastProps) {
  if (!errorInfo) return null;

  return createPortal(
    // BUG 2026-08-15: the banner was shrink-to-fit (absolute, left-0, no
    // width cap) — a long raw error message (e.g. "Failed to refresh
    // token: ...") stretched it past the viewport on mobile. max-w-full
    // caps it at #content-area width; the span's truncate then ellipsizes
    // and the title carries the full message for tooltip.
    <div className="absolute top-[76px] left-0 max-w-full h-11 bg-[#2a2b2f] text-white text-sm flex items-center z-50 select-none">
      <div className="flex items-center gap-3 px-4 flex-1 min-w-0">
        <ErrorIcon type={errorInfo.code} />
        <span className="font-medium truncate" title={errorText ?? undefined}>
          {errorText}
        </span>
      </div>
      <div className="w-1.5 self-stretch bg-brand-primary" />
    </div>,
    document.getElementById("content-area") || document.body,
  );
}
