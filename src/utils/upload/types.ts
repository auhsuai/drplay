export interface UploadEntry {
  id: string; // 'pending-<uuid>' until a real Drive id exists (also db.files row id)
  name: string;
  isFolder: boolean;
  parentId: string; // Drive destination folder ('root' is valid)
  diskPath?: string | undefined;
  bytes?: Blob | Uint8Array | undefined;
  status: "queued" | "uploading" | "done" | "error";
  error?: string | undefined; // only when status === 'error'
  progress?: number | undefined; // 0..1 fraction of bytes confirmed by Drive (chunked disk uploads)
}

export interface UploadSeed {
  name: string;
  isFolder: boolean;
  parentId: string;
  diskPath?: string;
  bytes?: Blob | Uint8Array;
}

export type UploadKind =
  "bytes" | "diskFile" | "folderRoot" | "folderChild" | "folderChildFile";

// Internal fields (token, memo, drive id) must never leak through the public contract.
export interface InternalEntry extends UploadEntry {
  token: string;
  kind: UploadKind;
  driveId?: string;
  relativeDir?: string; // dir path within a folder batch ('sub/sub2'; '' = batch root)
  batchMemo?: Map<string, string>; // shared per batch: relativeDir -> driveId ('' marker = enqueued)
  // Slice 5.2 resume metadata (from a persisted session row) — internal only:
  // uploadDiskPathChunked feeds these into the chunked uploader. `| undefined`
  // is explicit because a size-change drop CLEARS them mid-flight.
  resumeUri?: string | undefined; // persisted session URI (undefined = fresh upload)
  resumeTotalSize?: number | undefined; // persisted totalSize — for the size-change check
  resumeClientGeneratedId?: string | undefined; // persisted pre-generated id — reused for idempotency
}

export interface FolderBatch {
  entry: InternalEntry;
  memo: Map<string, string>;
}
