import { FileWarning, WifiOff } from "lucide-react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { PlayerErrorInfo } from "../../store/playerStore";

export interface ErrorToastProps {
  errorInfo: PlayerErrorInfo | null;
  /**
   * Render inline inside the local (relative) parent instead of the app-wide
   * `#content-area` portal. The full-screen NowPlaying surface sits above the
   * portal target (z-[9999] overlay vs z-50 toast), so it renders this same
   * banner inline from the shared store errorInfo (P2-12-6).
   */
  inline?: boolean;
}

function ErrorIcon({
  type,
  className = "w-5 h-5 shrink-0",
}: {
  type: string;
  className?: string;
}) {
  const Icon = type === "format_error" ? FileWarning : WifiOff;
  return <Icon className={`${className} text-brand-text`} />;
}

export function ErrorToast({ errorInfo, inline = false }: ErrorToastProps) {
  const { t } = useTranslation();

  if (!errorInfo) return null;

  // Why: AudioController keeps its VI-language strings as-is (not translated);
  // the toast maps the error codes to translated text so it matches the
  // active locale, and falls back to the raw message for unmapped codes.
  const errorText =
    errorInfo.code === "network_interrupted"
      ? t("player.network_interrupted")
      : errorInfo.code === "format_error"
        ? t("player.format_error")
        : errorInfo.code === "advance_stopped"
          ? t("player.advance_stopped")
          : errorInfo.message;

  const toast = (
    <div className="absolute top-[76px] left-0 h-11 bg-[#2a2b2f] text-white text-sm flex items-center z-50 select-none">
      <div className="flex items-center gap-3 px-4 flex-1 min-w-0">
        <ErrorIcon type={errorInfo.code} />
        <span className="font-medium truncate">{errorText}</span>
      </div>
      <div className="w-1.5 self-stretch bg-brand-primary" />
    </div>
  );

  if (inline) return toast;

  return createPortal(
    toast,
    document.getElementById("content-area") || document.body,
  );
}
