import { useState, useCallback, useEffect, useRef } from "react";
import type { Area } from "react-easy-crop";
import Cropper from "react-easy-crop";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { showErrorToast } from "../../utils/simpleToast";
import { captureError } from "../../utils/errorLog";

const CROPPER_MODULE = "ImageCropperModal";

interface ImageCropperModalProps {
  imageSrc: string;
  onClose: () => void;
  onSave: (croppedImageBase64: string) => void;
}

export function ImageCropperModal({
  imageSrc,
  onClose,
  onSave,
}: ImageCropperModalProps) {
  const { t } = useTranslation();
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => {
      previouslyFocused?.focus();
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (!isProcessing) onClose();
        return;
      }
      if (e.key !== "Tab") return;
      // Focus containment (WAI-ARIA APG modal dialog): Tab/Shift+Tab must not
      // reach the background. The focusable set is queried at keydown time
      // because the footer buttons become disabled while isProcessing (a
      // cached list would try to focus disabled elements).
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusables = dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      // The container itself (tabIndex={-1}) holds the initial focus; it is
      // not in `focusables`, so treat it (and a focus that somehow escaped)
      // as a boundary and wrap to the matching end.
      const insideDialog = dialog.contains(active);
      if (e.shiftKey) {
        if (!insideDialog || active === first || active === dialog) {
          e.preventDefault();
          last.focus();
        }
      } else if (!insideDialog || active === last || active === dialog) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, isProcessing]);

  const onCropComplete = useCallback(
    (_croppedArea: Area, croppedAreaPixels: Area) => {
      setCroppedAreaPixels(croppedAreaPixels);
    },
    [],
  );

  const handleOverlayClick = () => {
    if (isProcessing) return;
    onClose();
  };

  const handleSave = async () => {
    if (!croppedAreaPixels || !imageSrc) return;

    setIsProcessing(true);
    try {
      const croppedImage = await getCroppedImg(imageSrc, croppedAreaPixels);
      onSave(croppedImage);
    } catch (e) {
      void captureError({
        level: "error",
        source: CROPPER_MODULE,
        message: `save-cover-failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      showErrorToast(t("playlist.cover_save_error"));
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200"
      role="presentation"
      onClick={(e) => {
        // Only close when the backdrop itself (not the dialog) is clicked.
        if (e.target === e.currentTarget) handleOverlayClick();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cropper-title"
        tabIndex={-1}
        className="bg-white dark:bg-[#202124] rounded-2xl shadow-2xl w-full max-w-md overflow-hidden flex flex-col animate-in duration-200"
      >
        <div className="flex items-center justify-between p-4 border-b border-gray-100 dark:border-gray-800">
          <h3
            id="cropper-title"
            className="text-lg font-bold text-gray-900 dark:text-white"
          >
            {t("playlist.adjust_cover")}
          </h3>
          <button
            onClick={onClose}
            disabled={isProcessing}
            aria-label={t("playlist.close")}
            className="p-2 text-gray-500 hover:text-gray-900 dark:hover:text-white rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="relative w-full h-[400px] bg-black">
          <Cropper
            image={imageSrc}
            crop={crop}
            zoom={zoom}
            aspect={1}
            onCropChange={setCrop}
            onCropComplete={onCropComplete}
            onZoomChange={setZoom}
            objectFit="cover"
          />
        </div>

        <div className="p-4 space-y-4">
          <div>
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400 block mb-2 uppercase tracking-wider">
              {t("playlist.zoom")}
            </label>
            <input
              type="range"
              value={zoom}
              min={1}
              max={3}
              step={0.1}
              aria-label={t("playlist.zoom")}
              onChange={(e) => {
                setZoom(Number(e.target.value));
              }}
              className="w-full h-1.5 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer accent-brand-primary"
            />
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              onClick={onClose}
              disabled={isProcessing}
              className="px-4 py-2 rounded-xl text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-[#2a2b2f] transition-colors"
            >
              {t("menu.cancel")}
            </button>
            <button
              onClick={() => {
                void handleSave();
              }}
              disabled={isProcessing}
              className="px-6 py-2 rounded-xl text-sm font-bold bg-brand-primary hover:bg-brand-hover text-white shadow-md shadow-brand-primary/20 transition-all active:scale-95 disabled:opacity-50"
            >
              {isProcessing ? t("menu.saving") : t("menu.save")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function createImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    // Handlers are attached BEFORE src: an already-cached image can fire
    // load/error as soon as src is assigned, and a raw Event rejection logs
    // as "[object Event]".
    image.onload = () => {
      resolve(image);
    };
    image.onerror = () => {
      reject(new Error("crop-image-load-failed"));
    };
    image.src = url;
  });
}

async function getCroppedImg(
  imageSrc: string,
  pixelCrop: Area,
): Promise<string> {
  const image = await createImage(imageSrc);
  // The draw runs in the async body, NOT inside a bare onload callback: a
  // throw here rejects the returned promise. Throwing inside onload used to
  // leave the promise pending forever, stranding handleSave on await and
  // locking the modal (isProcessing never reset, nothing could close it).
  try {
    const canvas = document.createElement("canvas");
    // Encode as 512x512 resolution for optimal quality vs storage space
    const targetSize = 512;
    canvas.width = targetSize;
    canvas.height = targetSize;
    const ctx = canvas.getContext("2d");

    if (!ctx) {
      throw new Error("canvas-2d-context-unavailable");
    }

    ctx.drawImage(
      image,
      pixelCrop.x,
      pixelCrop.y,
      pixelCrop.width,
      pixelCrop.height,
      0,
      0,
      targetSize,
      targetSize,
    );

    return canvas.toDataURL("image/jpeg", 0.8);
  } catch (err) {
    throw new Error(
      `crop-draw-failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
