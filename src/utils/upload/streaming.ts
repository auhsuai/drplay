import type { DriveFileItem } from "../driveApi";
import {
  openDiskReadStream,
  registerUploadPath,
  statDiskPath,
} from "../diskFs";
import { UploadError, uploadFileResumableChunked } from "../driveUpload";
import { basename } from "../pathUtils";
import { controllerFor } from "./controllers";
import { scheduleProgressNotify } from "./events";
import {
  ERROR_QUOTA_EXCEEDED,
  ParentFolderMissingError,
  ResumeFileMissingError,
  requireDiskPath,
} from "./errors";
import { persistActiveSession } from "./session";
import { quotaAllows, tryGenerateClientId } from "./retry";
import type { InternalEntry } from "./types";

export async function handleDiskFile(
  entry: InternalEntry,
): Promise<DriveFileItem> {
  const path = requireDiskPath(entry);
  entry.name = basename(path);
  await registerUploadPath(path);
  return uploadDiskFileStreaming(entry, path);
}

export async function handleChildFile(
  entry: InternalEntry,
): Promise<DriveFileItem> {
  // The parent's drive id is only known once its own folder entry completed
  // (the queue is sequential, so it always has by the time a child runs).
  const dir = entry.relativeDir ?? "";
  const parentId = entry.batchMemo?.get(dir);
  if (!parentId) throw new ParentFolderMissingError(dir);
  entry.parentId = parentId;
  const path = requireDiskPath(entry);
  return uploadDiskFileStreaming(entry, path);
}

// Disk-path files stream in bounded chunks (~8 MiB in memory) instead of
// materializing the whole file in the JS heap — the fix for the multi-GB RAM
// spike when uploading large FLAC/WAV files. The file size comes from one stat
// (walk entries carry size 0), which also feeds the quota check.
async function uploadDiskFileStreaming(
  entry: InternalEntry,
  path: string,
): Promise<DriveFileItem> {
  const stat = await statDiskPath(path);
  if (stat === null || stat.isDirectory) {
    // A RESUMED file that vanished (deleted/moved/renamed) gets a distinct
    // failure + toast so the user knows the file is gone; a fresh upload keeps
    // the legacy plain Error (generic failed entry, same behavior as before).
    if (entry.resumeUri !== undefined) {
      throw new ResumeFileMissingError(basename(path));
    }
    // Plain Error (not UploadError) so the entry shows 'failed', same as the
    // old whole-file read failure.
    throw new Error(`file not found on disk: ${basename(path)}`);
  }
  // The file changed size since the interruption: the old session's
  // Content-Range is invalid, and its pre-generated id may already own a
  // server-side file of the OLD size (a same-id retry would resolve DONE
  // against the stale file). Drop BOTH — the upload silently restarts from 0
  // with the new size and a fresh id.
  if (
    entry.resumeTotalSize !== undefined &&
    stat.size !== entry.resumeTotalSize
  ) {
    entry.resumeUri = undefined;
    entry.resumeClientGeneratedId = undefined;
  }
  // Persist the freshly-statted size so a FUTURE resume can run the same
  // size-change check (best-effort — persistActiveSession logs its own warn).
  await persistActiveSession(entry, { totalSize: stat.size });
  if (!(await quotaAllows(entry, stat.size))) {
    throw new UploadError(ERROR_QUOTA_EXCEEDED, "quota");
  }
  return uploadDiskPathChunked(entry, path, stat.size);
}

async function uploadDiskPathChunked(
  entry: InternalEntry,
  path: string,
  totalSize: number,
): Promise<DriveFileItem> {
  // Generated ONCE per logical upload: the chunked uploader restarts its
  // session internally (MAX_UPLOAD_ATTEMPTS), and every session must stay
  // bound to the same pre-generated id (idempotent retry — see tryGenerateClientId).
  // A RESUMED upload REUSES the id persisted with its session (slice 5.2): a
  // retry that already completed server-side then answers 409 → resolve DONE
  // with the real file instead of creating a duplicate.
  const clientGeneratedId =
    entry.resumeClientGeneratedId ?? (await tryGenerateClientId(entry));
  let stream = await openDiskReadStream(path);
  let consumed = 0;
  // Tail of a chunk that straddled the requested skip offset, served before
  // the stream is read again so every returned chunk starts exactly at the
  // offset the resumable session asked for.
  let remainder: Uint8Array | null = null;
  const readChunk = async (offset: number): Promise<Uint8Array | null> => {
    if (offset < consumed) {
      // A 308 resume can ask for bytes we already consumed (server received
      // fewer than sent). The rid-backed handle only reads forward, so reopen
      // the stream and skip to the requested offset.
      await stream.close();
      stream = await openDiskReadStream(path);
      consumed = 0;
      remainder = null;
    }
    while (consumed < offset) {
      const skipped = await stream.read();
      if (skipped === null) break;
      const next = consumed + skipped.byteLength;
      if (next > offset) {
        // The chunk straddles the requested offset: keep its tail (starting
        // exactly at `offset`) instead of discarding it — the old
        // discard-then-read desynced the stream and uploaded data shifted by
        // `next - offset` bytes, silently corrupting the file.
        remainder = skipped.slice(offset - consumed);
        consumed = offset;
        break;
      }
      consumed = next;
    }
    if (remainder !== null) {
      const r = remainder;
      remainder = null;
      consumed += r.byteLength;
      return r;
    }
    const chunk = await stream.read();
    if (chunk === null) return null;
    consumed += chunk.byteLength;
    return chunk;
  };
  try {
    return await uploadFileResumableChunked(entry.token, {
      name: entry.name,
      parentId: entry.parentId,
      totalSize,
      readChunk,
      // The entry's cancel controller is wired into the real uploader so a
      // cancelUpload aborts the in-flight Drive request (driveApi rejects
      // with UploadError('aborted')).
      signal: controllerFor(entry)?.signal,
      clientGeneratedId,
      // Slice 5.2: seed the uploader with the persisted session URI — attempt
      // 0 queries its status (308 → continue at the server byte, 200 → done,
      // 404 → fresh session). Undefined for fresh uploads and after a
      // size-change drop, both meaning "start from 0".
      initialUploadUri: entry.resumeUri,
      // Persist the live session URI as soon as a session exists (best-effort,
      // fire-and-forget): a crash after this point can still resume. A failed
      // write costs only the resume — persistActiveSession never throws.
      onSessionUpdate: (uploadUri) => {
        void persistActiveSession(entry, {
          uploadUri,
          ...(clientGeneratedId !== undefined ? { clientGeneratedId } : {}),
          totalSize,
        });
      },
      // Progress is written silently on the entry and surfaced via a throttled
      // notify (at most one per PROGRESS_NOTIFY_INTERVAL_MS): onProgress can
      // fire once per chunk (128× on a 1 GB file = 128 chunks) and per-chunk
      // notifies would spam subscribers.
      onProgress: (fraction) => {
        entry.progress = fraction;
        scheduleProgressNotify(entry);
      },
    });
  } finally {
    await stream.close();
  }
}
