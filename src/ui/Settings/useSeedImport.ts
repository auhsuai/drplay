import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { showErrorToast, showSuccessToast } from "../../utils/simpleToast";
import { captureError } from "../../utils/errorLog";

interface ImportSeedStats {
  metadataCount: number;
  coverCount: number;
  skipped: number;
}

export function useSeedImport(): {
  importingSeed: boolean;
  handleImportSeed: () => Promise<void>;
} {
  const { t } = useTranslation();
  const [importingSeed, setImportingSeed] = useState(false);
  // Synchronous re-entrancy guard: `importingSeed` only flips true AFTER the
  // native dialog closes, so two quick clicks would otherwise open two
  // dialogs (and Rust would reject the second import with a confusing error).
  const busyRef = useRef(false);

  // Seed offline import (2026-08-10): one-shot restore of a metadata+cover
  // backup produced by the Colab scanner. The picked zip is unpacked by Rust
  // (import_metadata_seed) into <app_cache_dir>/metadata + /covers; mounted
  // cards pick the data up on their next fetch (disk-first), already-mounted
  // placeholders refresh on re-mount — the toast is the import's own signal.
  const handleImportSeed = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const selected = await open({
        directory: false,
        multiple: false,
        filters: [{ name: t("settings.import_seed"), extensions: ["zip"] }],
      });
      // Cancelled / no selection: nothing to import.
      if (typeof selected !== "string") return;
      setImportingSeed(true);
      try {
        const stats = await invoke<ImportSeedStats>("import_metadata_seed", {
          zipPath: selected,
        });
        showSuccessToast(
          t("settings.import_seed_success", {
            metadata: stats.metadataCount,
            covers: stats.coverCount,
            skipped: stats.skipped,
          }),
        );
      } catch (err) {
        await captureError({
          level: "error",
          source: "SettingsTab",
          message: `import-seed-failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        showErrorToast(t("settings.import_seed_error"));
      } finally {
        setImportingSeed(false);
      }
    } catch (err) {
      await captureError({
        level: "error",
        source: "SettingsTab",
        message: `open-seed-dialog-failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      showErrorToast(t("settings.import_seed_error"));
    } finally {
      busyRef.current = false;
    }
  };

  return { importingSeed, handleImportSeed };
}
