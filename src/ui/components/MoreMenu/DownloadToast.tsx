import { createPortal } from "react-dom";
import { CheckCircle2 } from "lucide-react";

interface DownloadToastProps {
  message: string;
}

export function DownloadToast({ message }: DownloadToastProps) {
  return createPortal(
    <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[9999] animate-in slide-in-from-bottom-5 fade-in duration-300 w-full max-w-[90vw] md:max-w-md pointer-events-none">
      <div className="bg-white dark:bg-[#2a2b2f] text-gray-900 dark:text-white shadow-xl shadow-black/10 dark:shadow-black/30 rounded-full px-5 py-3 flex items-center gap-3">
        <div className="w-6 h-6 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center shrink-0">
          <CheckCircle2 className="w-4 h-4 text-green-600 dark:text-green-400" />
        </div>
        <p className="text-sm font-medium truncate" title={message}>
          {message}
        </p>
      </div>
    </div>,
    document.body,
  );
}
