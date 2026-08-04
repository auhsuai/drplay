import { driveFetch, FOLDER_MIME } from "./driveApi";
import type { DriveFileItem, DriveFolderItem } from "./driveApi";

// Drive files.list caps each request at 1000 results (docs: values above 1000
// are coerced to 1000). We aggregate pages so large folders/searches are never
// silently truncated in the UI.
const PAGINATION_PAGE_SIZE = 1000;
// Worst-case safety cap: 10 pages = up to 10,000 results per call. Guards
// against a misbehaving server that keeps issuing nextPageToken forever.
const MAX_PAGINATION_PAGES = 10;

// Aggregate ALL pages of a Drive files.list query. Drive caps each request at
// PAGINATION_PAGE_SIZE and signals more results via nextPageToken
// (developers.google.com/workspace/drive/api/reference/rest/v3/files/list).
// The official samples always include nextPageToken in the `fields` mask — a
// partial-response mask without it silently drops the token, so the caller
// MUST pass a fields string that contains it. Break (not throw) if the caller
// aborts between pages; per-request aborts still reject via driveFetch.
// Generic over the item type so the folder listers and the trash lister share
// one loop instead of two copy-pasted copies. orderBy defaults to name; the
// trash lister overrides it with folder,name (its screen sorts folders first).
async function fetchAllPages<T>(
  token: string,
  query: string,
  fields: string,
  failureLabel: string,
  signal?: AbortSignal,
  orderBy: string = "name",
): Promise<T[]> {
  const baseUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=${fields}&orderBy=${orderBy}&pageSize=${PAGINATION_PAGE_SIZE}`;
  const all: T[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGINATION_PAGES; page++) {
    if (signal?.aborted) break;
    const url = pageToken
      ? `${baseUrl}&pageToken=${encodeURIComponent(pageToken)}`
      : baseUrl;
    const response = await driveFetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      throw new Error(`Failed to ${failureLabel} (${response.status})`);
    }
    let data: { files?: T[]; nextPageToken?: string };
    try {
      data = (await response.json()) as { files?: T[]; nextPageToken?: string };
    } catch {
      // A 200 body that is not JSON (proxy/truncated response) would otherwise
      // surface as a raw SyntaxError from json(); classify it so callers can
      // show a meaningful message. Never log the raw body (may be huge/opaque).
      throw new Error(`Failed to ${failureLabel} (malformed response)`);
    }
    if (data.files) all.push(...data.files);
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return all;
}

// Folder-typed wrapper around the generic paginator; keeps the folder listers
// reading at the DriveFolderItem level (behavior and signature unchanged).
async function fetchAllFolderPages(
  token: string,
  query: string,
  fields: string,
  failureLabel: string,
  signal?: AbortSignal,
): Promise<DriveFolderItem[]> {
  return fetchAllPages<DriveFolderItem>(
    token,
    query,
    fields,
    failureLabel,
    signal,
  );
}

// Search for folders matching a fully-built Drive query string.
// `query` must already be a valid Drive q-expression (e.g. escaped/quoted).
export async function searchFolders(
  token: string,
  query: string,
  signal?: AbortSignal,
): Promise<DriveFolderItem[]> {
  return fetchAllFolderPages(
    token,
    query,
    "nextPageToken,files(id,name)",
    "search folders",
    signal,
  );
}

// List immediate folder children (subfolders only, not trashed).
export async function listFolderChildren(
  token: string,
  folderId: string,
  signal?: AbortSignal,
): Promise<DriveFolderItem[]> {
  const q = `'${folderId}' in parents and trashed=false and mimeType='${FOLDER_MIME}'`;
  return fetchAllFolderPages(
    token,
    q,
    "nextPageToken,files(id,name)",
    "list folder children",
    signal,
  );
}

// Fetch trashed items matching a fully-built Drive query string.
// Drive caps each request at PAGINATION_PAGE_SIZE results, so a trash list
// larger than one page was silently truncated without a nextPageToken loop
// (same pagination pattern as fetchAllFolderPages). nextPageToken MUST stay in
// the fields mask — Drive's partial response drops it otherwise. Keep
// orderBy=folder,name so folders sort before files in the trash screen.
export async function getTrashedFiles(
  token: string,
  query: string,
  signal?: AbortSignal,
): Promise<DriveFileItem[]> {
  return fetchAllPages<DriveFileItem>(
    token,
    query,
    "nextPageToken,files(id,name,mimeType)",
    "fetch trashed files",
    signal,
    "folder,name",
  );
}
