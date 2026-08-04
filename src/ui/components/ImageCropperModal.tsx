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
      if (e.key === "Escape" && !isProcessing) onClose();
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
      showErrorToast(
        t("playlist.cover_save_error") || "Failed to save cover image",
      );
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
            {t("playlist.adjust_cover", "Điều chỉnh ảnh bìa")}
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
              {t("playlist.zoom", "Phóng to")}
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
              className="w-full h-1.5 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer accent-[#4285F4]"
            />
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              onClick={onClose}
              disabled={isProcessing}
              className="px-4 py-2 rounded-xl text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-[#2a2b2f] transition-colors"
            >
              {t("menu.cancel", "Hủy")}
            </button>
            <button
              onClick={() => {
                void handleSave();
              }}
              disabled={isProcessing}
              className="px-6 py-2 rounded-xl text-sm font-bold bg-[#4285F4] hover:bg-[#3367d6] text-white shadow-md shadow-[#4285F4]/20 transition-all active:scale-95 disabled:opacity-50"
            >
              {isProcessing
                ? t("menu.saving", "Đang lưu...")
                : t("menu.save", "Lưu")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function getCroppedImg(imageSrc: string, pixelCrop: Area): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.src = imageSrc;
    image.onload = () => {
      const canvas = document.createElement("canvas");
      // Encode as 512x512 resolution for optimal quality vs storage space
      const targetSize = 512;
      canvas.width = targetSize;
      canvas.height = targetSize;
      const ctx = canvas.getContext("2d");

      if (!ctx) {
        reject(new Error("canvas-2d-context-unavailable"));
        return;
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

      resolve(canvas.toDataURL("image/jpeg", 0.8));
    };
    image.onerror = reject;
  });
}
