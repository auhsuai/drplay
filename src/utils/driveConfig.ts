import { captureError } from "./errorLog";
import { classifyDriveError, driveFetch } from "./driveHttp";
import { DRIVE_MODULE } from "./driveTypes";
import { authHeaders, DRIVE_FILES_URL, parseFilesList } from "./driveFiles";

const CONFIG_FILENAME = "drplay_config.json";
const APP_DATA_FOLDER = "appDataFolder";

// App Configuration in appDataFolder
// Search URL for the config file in appDataFolder (shared by getAppConfig and
// saveAppConfigInternal so both always query the exact same endpoint).
function buildConfigSearchUrl(): string {
  const q = `name = '${CONFIG_FILENAME}' and '${APP_DATA_FOLDER}' in parents`;
  return `${DRIVE_FILES_URL}?spaces=appDataFolder&q=${encodeURIComponent(q)}&fields=files(id)`;
}

// Shared search helper: query appDataFolder for the config file. The ok flag
// separates a FAILED search (non-ok response — the write path must abort to
// avoid a blind POST that could create a duplicate config file) from a
// SUCCESSFUL search that simply found no file (fileId null — the first-save
// path that may POST a brand-new file).
type ConfigSearchResult =
  { ok: true; fileId: string | null } | { ok: false; status: number };

async function findConfigFileId(
  token: string,
  signal?: AbortSignal,
): Promise<ConfigSearchResult> {
  const url = buildConfigSearchUrl();
  const searchRes = await driveFetch(url, {
    headers: authHeaders(token),
    ...(signal ? { signal } : {}),
  });
  if (!searchRes.ok) {
    return { ok: false, status: searchRes.status };
  }
  const searchData: unknown = await searchRes.json();
  const files = parseFilesList(searchData);
  const first = files[0];
  return { ok: true, fileId: first === undefined ? null : first.id };
}

/**
 * Read the app config JSON from Drive's appDataFolder (invisible to the
 * user's Drive UI). The config is the source of truth for app settings that
 * must survive reinstalls; a missing/corrupt file or a failed request returns
 * null so the app falls back to defaults. Failures never throw: network/parse
 * errors and non-ok responses (search or download) all log and return null.
 * @param token Drive access token.
 * @param signal Optional AbortSignal to cancel the request (e.g. unmount).
 * @returns The parsed config object, or null when absent/unreadable.
 */
export async function getAppConfig(
  token: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  try {
    const search = await findConfigFileId(token, signal);
    if (!search.ok) {
      await captureError({
        level: "warn",
        source: DRIVE_MODULE,
        message: `get-config-search-failed (status=${String(search.status)})`,
      });
      return null;
    }
    const fileId = search.fileId;
    if (fileId === null) return null;

    const downloadUrl = `${DRIVE_FILES_URL}/${fileId}?alt=media`;
    const downloadRes = await driveFetch(downloadUrl, {
      headers: authHeaders(token),
      ...(signal ? { signal } : {}),
    });

    if (downloadRes.ok) {
      const config: unknown = await downloadRes.json();
      return config as Record<string, unknown> | null;
    }
    await captureError({
      level: "warn",
      source: DRIVE_MODULE,
      message: `get-config-download-failed (status=${String(downloadRes.status)})`,
    });
  } catch (e: unknown) {
    await captureError({
      level: "error",
      source: DRIVE_MODULE,
      message: `get-config-failed: ${classifyDriveError(e)}`,
    });
  }
  return null;
}

// Serialize config writes with a promise-chain mutex. Two concurrent saves
// would otherwise both search (find nothing), both POST, and create duplicate
// drplay_config.json files in appDataFolder (Drive has no conditional upsert).
// A chain of gate promises gives FIFO fairness (each task waits on the previous
// task's gate) without polling: no busy-wait, no wasted event-loop spins, no
// magic poll interval. release() always runs in finally, and prev.catch()
// swallows a rejected predecessor's gate so a failed save can never leave the
// lock stuck. Nested calls deadlock (a task awaiting its own gate) — same as
// the previous boolean-flag lock, so that behavior is unchanged.
// Exported (like backoffDelay) so tests can assert the lock semantics directly.
let lockTail: Promise<unknown> = Promise.resolve();

export async function withSaveConfigLock<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prev = lockTail;
  lockTail = gate;
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

async function saveAppConfigInternal(
  token: string,
  config: unknown,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const search = await findConfigFileId(token, signal);
    if (!search.ok) {
      await captureError({
        level: "warn",
        source: DRIVE_MODULE,
        message: "config-search-failed, skip upload",
      });
      return false;
    }
    const fileId = search.fileId;

    const boundary = "-------314159265358979323846";
    const delimiter = `\r\n--${boundary}\r\n`;
    const close_delim = `\r\n--${boundary}--`;

    const metadata = {
      name: CONFIG_FILENAME,
      mimeType: "application/json",
      ...(fileId ? {} : { parents: [APP_DATA_FOLDER] }),
    };

    const multipartRequestBody =
      delimiter +
      "Content-Type: application/json\r\n\r\n" +
      JSON.stringify(metadata) +
      delimiter +
      "Content-Type: application/json\r\n\r\n" +
      JSON.stringify(config) +
      close_delim;

    const uploadUrl = fileId
      ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`
      : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;

    const uploadRes = await driveFetch(uploadUrl, {
      method: fileId ? "PATCH" : "POST",
      headers: {
        ...authHeaders(token),
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body: multipartRequestBody,
      ...(signal ? { signal } : {}),
    });

    if (!uploadRes.ok) {
      await captureError({
        level: "error",
        source: DRIVE_MODULE,
        message: `save-config-upload-failed (status=${String(uploadRes.status)})`,
      });
      return false;
    }
    return true;
  } catch (e: unknown) {
    await captureError({
      level: "error",
      source: DRIVE_MODULE,
      message: `save-config-failed: ${classifyDriveError(e)}`,
    });
    return false;
  }
}

/**
 * Write the app config JSON to Drive's appDataFolder, creating the file on
 * first save and PATCHing it afterwards. Serialized through a promise-chain
 * mutex (withSaveConfigLock): two concurrent saves would both search, find
 * nothing, and POST — creating duplicate config files (Drive has no
 * conditional upsert). A failed search (non-ok) aborts the save without
 * POSTing — blind-POSTing on a 4xx search could create a second duplicate
 * config file. Failures log and return false; the caller keeps using its
 * in-memory config.
 * @param token Drive access token.
 * @param config Any JSON-serializable config object.
 * @param signal Optional AbortSignal forwarded to the Drive calls inside the
 * lock (the lock itself is never aborted).
 * @returns true when Drive confirmed the write, false on any failure.
 */
export async function saveAppConfig(
  token: string,
  config: unknown,
  signal?: AbortSignal,
): Promise<boolean> {
  return withSaveConfigLock(() => saveAppConfigInternal(token, config, signal));
}
