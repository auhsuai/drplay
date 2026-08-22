import type { DriveFileItem } from "../driveApi";
import {
  openDiskReadStream,
  registerUploadPath,
  statDiskPath,
} from "../diskFs";
import type { DiskReadStream } from "../diskFs";
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
  // The parent's drive id is only known once its own folder entry completed:
  // nextQueued() keeps a folderChildFile blocked while the parent's batchMemo
  // lacks it, under any UPLOAD_CONCURRENCY (not because of sequencing).
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

// Mutable state of the sequential chunk reader over one DiskReadStream
// (bounded ~8 MiB in memory). Passed BY REFERENCE across readChunk calls
// because the uploader may re-read at arbitrary offsets after a 308 resume —
// the reopened stream / consumed counter / straddle remainder all mutate.
interface ChunkReaderState {
  stream: DiskReadStream;
  consumed: number;
  // Tail of a disk chunk that straddled the requested skip offset or exceeded
  // the requested size hint, served before the stream is read again so every
  // returned chunk starts exactly at the offset the resumable session asked
  // for and never exceeds the size hint it budgeted.
  remainder: Uint8Array | null;
}

// Read up to `sizeHint` bytes starting exactly at `offset`. A 308 resume can
// ask for bytes we already consumed (server received fewer than sent); the
// rid-backed handle only reads forward, so the stream is reopened and skipped
// to the requested offset. When a skipped chunk straddles the offset, its tail
// (starting exactly at `offset`) is kept instead of discarded — the old
// discard-then-read desynced the stream and uploaded data shifted by
// `next - offset` bytes, silently corrupting the file. Disk reads stay at
// DEFAULT_READ_CHUNK_SIZE regardless of the adapted chunk level, so an
// oversized read is sliced to `sizeHint` and its tail flows through the SAME
// remainder mechanism as a straddled chunk — one path, no byte loss.
async function readChunkFromState(
  state: ChunkReaderState,
  path: string,
  offset: number,
  sizeHint?: number,
): Promise<Uint8Array | null> {
  if (offset < state.consumed) {
    await state.stream.close();
    state.stream = await openDiskReadStream(path);
    state.consumed = 0;
    state.remainder = null;
  }
  while (state.consumed < offset) {
    const skipped = await state.stream.read();
    if (skipped === null) break;
    const next = state.consumed + skipped.byteLength;
    if (next > offset) {
      state.remainder = skipped.slice(offset - state.consumed);
      state.consumed = offset;
      break;
    }
    state.consumed = next;
  }
  // No sizeHint: the historical contract — serve the straddle remainder, or
  // exactly ONE disk read, without accumulating (hint-less callers keep the
  // pre-adaptive behavior).
  if (sizeHint === undefined) {
    if (state.remainder !== null) {
      const r = state.remainder;
      state.remainder = null;
      state.consumed += r.byteLength;
      return r;
    }
    const chunk = await state.stream.read();
    if (chunk === null) return null;
    state.consumed += chunk.byteLength;
    return chunk;
  }
  // Serve at most `limit` bytes: the straddle/oversize tail first, then more
  // disk reads (a short read — nread < requested — also fills in). Only an
  // end-of-file read may leave the result shorter than the limit.
  const parts: Uint8Array[] = [];
  let total = 0;
  if (state.remainder !== null) {
    const tail = state.remainder;
    state.remainder = null;
    const take = Math.min(tail.byteLength, sizeHint);
    parts.push(tail.slice(0, take));
    total += take;
    state.consumed += take;
    if (tail.byteLength > take) state.remainder = tail.slice(take);
  }
  while (total < sizeHint) {
    const chunk = await state.stream.read();
    if (chunk === null) break;
    const take = Math.min(chunk.byteLength, sizeHint - total);
    parts.push(chunk.slice(0, take));
    total += take;
    state.consumed += take;
    if (chunk.byteLength > take) {
      state.remainder = chunk.slice(take);
      break;
    }
  }
  if (parts.length === 0) return null;
  return concatBytes(parts);
}

// Concatenate the reader's parts (straddle/oversize tail + one or more disk
// reads) — max 2 parts in practice (8 MiB disk read vs ≤ 8 MiB limit), so the
// allocation cost is trivial.
function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

async function uploadDiskPathChunked(
  entry: InternalEntry,
  path: string,
  totalSize: number,
): Promise<DriveFileItem> {
  // Generated ONCE per logical upload: the chunked uploader restarts its
  // session internally (CHUNKED_SESSION_MAX_ATTEMPTS), and every session must stay
  // bound to the same pre-generated id (idempotent retry — see tryGenerateClientId).
  // A RESUMED upload REUSES the id persisted with its session (slice 5.2): a
  // retry that already completed server-side then answers 409 → resolve DONE
  // with the real file instead of creating a duplicate.
  const clientGeneratedId =
    entry.resumeClientGeneratedId ?? (await tryGenerateClientId(entry));
  const reader: ChunkReaderState = {
    stream: await openDiskReadStream(path),
    consumed: 0,
    remainder: null,
  };
  try {
    return await uploadFileResumableChunked(entry.token, {
      name: entry.name,
      parentId: entry.parentId,
      totalSize,
      readChunk: (offset, sizeHint) =>
        readChunkFromState(reader, path, offset, sizeHint),
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
    await reader.stream.close();
  }
}
