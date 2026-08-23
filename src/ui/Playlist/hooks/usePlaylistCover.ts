import { useRef, useState } from "react";
import type { ChangeEvent, Dispatch, RefObject, SetStateAction } from "react";
import type { Playlist } from "../../../utils/playlists";
import { updatePlaylist } from "../../../utils/playlists";
import { showErrorToast } from "../../../utils/simpleToast";
import { captureError } from "../../../utils/errorLog";
import { useHardwareBack } from "../../../hooks/useHardwareBack";
import { useTranslation } from "react-i18next";

// Mirrors the host view's tag on purpose: these cover flows were part of
// PlaylistView before the Phase-A extraction, so their captureError payloads
// keep source: "PlaylistView" for stable log triage.
const PLAYLIST_VIEW_MODULE = "PlaylistView";

// Hoisted from the component body during the Phase-A extraction — same value,
// now evaluated once at module load instead of once per render.
const MAX_COVER_BYTES = 5 * 1024 * 1024;

/**
 * Cover/cropper state machine for PlaylistView: hidden file input, selected
 * image, cropper modal visibility, validation + save handlers, and the
 * hardware-back wiring that closes the cropper while it owns the foreground.
 */
export function usePlaylistCover({
  playlistId,
  onPlaylistUpdated,
}: {
  playlistId: string;
  /** Applied after a successful cover save (the view passes setPlaylist). */
  onPlaylistUpdated: (updated: Playlist) => void;
}): {
  fileInputRef: RefObject<HTMLInputElement | null>;
  selectedImage: string | null;
  isCropperOpen: boolean;
  setIsCropperOpen: Dispatch<SetStateAction<boolean>>;
  setSelectedImage: Dispatch<SetStateAction<string | null>>;
  handleFileChange: (e: ChangeEvent<HTMLInputElement>) => void;
  handleSaveCover: (base64Img: string) => Promise<void>;
} {
  const { t } = useTranslation();
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [isCropperOpen, setIsCropperOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Hardware back (mobile): closes the ImageCropperModal when it owns the
  // foreground — without this, the back press falls through the App-level
  // chain (LikedSongs tab is its own layer) and pops the playlist instead.
  // selectedImage is cleared alongside the modal so the next open starts
  // from a clean state, matching the in-modal Cancel path. The view must
  // call this hook ABOVE its early `if (!playlist) return null` so hook
  // order stays stable across the null/non-null re-renders.
  useHardwareBack(() => {
    setIsCropperOpen(false);
    setSelectedImage(null);
    return true;
  }, isCropperOpen);

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      showErrorToast(t("playlist.cover_invalid_type"));
      return;
    }
    if (file.size > MAX_COVER_BYTES) {
      showErrorToast(t("playlist.cover_too_large"));
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      setSelectedImage(event.target?.result as string);
      setIsCropperOpen(true);
    };
    reader.onerror = () => {
      void captureError({
        level: "error",
        source: PLAYLIST_VIEW_MODULE,
        message: `read-cover-failed: name=${file.name}, size=${String(file.size)}`,
      });
      showErrorToast(t("playlist.cover_read_error"));
    };
    reader.readAsDataURL(file);
  };

  const handleSaveCover = async (base64Img: string) => {
    setIsCropperOpen(false);
    setSelectedImage(null);
    try {
      const updated = await updatePlaylist(playlistId, {
        coverImage: base64Img,
      });
      if (updated) {
        onPlaylistUpdated(updated);
      }
    } catch (err) {
      void captureError({
        level: "error",
        source: PLAYLIST_VIEW_MODULE,
        message: `update-cover-failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      showErrorToast(t("playlist.cover_save_error"));
    }
  };

  return {
    fileInputRef,
    selectedImage,
    isCropperOpen,
    setIsCropperOpen,
    setSelectedImage,
    handleFileChange,
    handleSaveCover,
  };
}
