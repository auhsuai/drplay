import { createPortal } from "react-dom";
import { Check } from "lucide-react";

interface DownloadToastProps {
  message: string;
}

export function DownloadToast({ message }: DownloadToastProps) {
  return createPortal(
    <div className="absolute bottom-20 left-0 z-[9999] animate-in slide-in-from-left-5 fade-in duration-300 w-full max-w-[90vw] md:max-w-md pointer-events-none">
      <div className="bg-white dark:bg-[#2a2b2f] text-gray-900 dark:text-white rounded-full px-5 py-3 flex items-center gap-3">
        <Check className="w-4 h-4 text-green-600 dark:text-green-400 shrink-0" />
        <p className="text-sm font-medium truncate" title={message}>
          {message}
        </p>
      </div>
    </div>,
    document.getElementById("content-area") || document.body,
  );
}
