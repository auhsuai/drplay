import React from "react";
import { Check, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cancelUpload } from "../../../utils/uploadManager";
import type { UploadState } from "../../../utils/uploadManager";
import { ProgressRing } from "./ProgressRing";

export function UploadBadge({
  state,
  progress,
  itemId,
}: {
  state: UploadState;
  progress: number | undefined;
  itemId: string;
}): React.JSX.Element {
  const { t } = useTranslation();

  if (state === "uploading") {
    // The determinate ring lives where the menu sits (right edge), not
    // next to the title. Hovering the ring reveals the X cancel button
    // inside it (pointer-events-auto: the dimmed card is
    // pointer-events-none, but cancel must stay clickable).
    return (
      <div className="relative w-5 h-5 shrink-0">
        <ProgressRing fraction={progress} />
        <button
          type="button"
          aria-label={t("upload.cancel_upload")}
          // Tailwind v4 gates hover: behind @media (hover:hover), so on
          // touch devices group-hover never fires — force-reveal the X via
          // focus-visible/active and an explicit hover:none query.
          className="pointer-events-auto absolute inset-0 flex items-center justify-center rounded-full opacity-0 group-hover/upload:opacity-100 hover:text-red-500 focus-visible:opacity-100 focus-visible:text-red-500 active:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity text-gray-500"
          onClick={(e) => {
            e.stopPropagation();
            cancelUpload(itemId);
          }}
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    );
  }

  // Just-finished upload: single-tick check (user design) in place
  // of the menu; disappears on play, on tab switch, or after the
  // short tint.
  return (
    <div
      className="w-5 h-5 flex items-center justify-center pointer-events-none"
      aria-label={t("upload.uploaded")}
    >
      <Check className="w-4 h-4 text-brand-primary" />
    </div>
  );
}
