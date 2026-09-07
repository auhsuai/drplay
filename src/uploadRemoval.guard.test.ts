// Guard test: the upload feature was removed (files only enter the app via
// PC/Drive web sync; the app is download + sync only). This test fails if any
// source file re-imports a deleted upload module, so a future reintroduction
// cannot slip in unnoticed.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const SRC_ROOT = join(__dirname, "..");
// Module specifiers whose presence means the upload stack came back.
const FORBIDDEN_SPECIFIERS = [
  "utils/uploadManager",
  "utils/upload/",
  "uploadFileResumable",
  "uploadFileResumableChunked",
  "chunkedUploadLoop",
  "driveUpload",
  "uploadTransportErrors",
  "resumableSession",
  "resumableStatus",
];
const FORBIDDEN_FILES = [
  "src/utils/uploadManager.ts",
  "src/utils/driveUpload.ts",
  "src/utils/chunkedUploadLoop.ts",
  "src/utils/uploadFileResumable.ts",
  "src/utils/uploadFileResumableChunked.ts",
  "src/utils/uploadTransportErrors.ts",
  "src/utils/resumableSession.ts",
  "src/utils/resumableStatus.ts",
  "src/utils/upload",
  "src/ui/components/UploadButton.tsx",
  "src/ui/components/DropZone.tsx",
  "src/ui/Settings/useActiveUploads.ts",
  "src/ui/Settings/components/UploadsSection.tsx",
  "src/ui/MainContent/components/UploadBadge.tsx",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

describe("upload feature removal guard", () => {
  it("keeps the deleted upload modules deleted", () => {
    const reappeared = FORBIDDEN_FILES.filter((rel) =>
      existsSync(join(__dirname, "../..", rel)),
    );
    expect(reappeared).toEqual([]);
  });

  it("keeps the whole src/ tree free of upload-module imports", () => {
    const offenders: string[] = [];
    const self = __filename;
    for (const file of walk(SRC_ROOT)) {
      // The guard's own literal specifiers must not match themselves.
      if (file === self) continue;
      const text = readFileSync(file, "utf8");
      for (const spec of FORBIDDEN_SPECIFIERS) {
        if (text.includes(spec)) {
          offenders.push(`${file} -> ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
