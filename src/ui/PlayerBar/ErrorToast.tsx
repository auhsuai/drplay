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
  return <Icon className={`${className} text-[#4285F4]`} />;
}

export function ErrorToast({ errorInfo, errorText }: ErrorToastProps) {
  if (!errorInfo) return null;

  return createPortal(
    <div className="absolute top-[76px] left-0 h-11 bg-[#2a2b2f] text-white text-sm flex items-center z-50 select-none">
      <div className="flex items-center gap-3 px-4 flex-1 min-w-0">
        <ErrorIcon type={errorInfo.code} />
        <span className="font-medium truncate">{errorText}</span>
      </div>
      <div className="w-1.5 self-stretch bg-[#4285F4]" />
    </div>,
    document.getElementById("content-area") || document.body,
  );
}
