import { captureError } from "./errorLog";
import { classifyDriveError, driveFetch } from "./driveHttp";
import { DRIVE_MODULE } from "./driveTypes";
import { authHeaders, parseFilesList } from "./driveFiles";

const CONFIG_FILENAME = "drplay_config.json";
const APP_DATA_FOLDER = "appDataFolder";

// App Configuration in appDataFolder
// Search URL for the config file in appDataFolder (shared by getAppConfig and
// saveAppConfigInternal so both always query the exact same endpoint).
function buildConfigSearchUrl(): string {
  const q = `name = '${CONFIG_FILENAME}' and '${APP_DATA_FOLDER}' in parents`;
  return `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${encodeURIComponent(q)}&fields=files(id)`;
}

/**
 * Read the app config JSON from Drive's appDataFolder (invisible to the
 * user's Drive UI). The config is the source of truth for app settings that
 * must survive reinstalls; a missing/corrupt file or a failed request returns
 * null so the app falls back to defaults (logged, never thrown).
 * @param token Drive access token.
 * @returns The parsed config object, or null when absent/unreadable.
 */
export async function getAppConfig(
  token: string,
): Promise<Record<string, unknown> | null> {
  const url = buildConfigSearchUrl();

  try {
    const searchRes = await driveFetch(url, {
      headers: authHeaders(token),
    });

    if (!searchRes.ok) return null;
    const searchData: unknown = await searchRes.json();
    const files = parseFilesList(searchData);

    if (files.length > 0) {
      const first = files[0];
      if (first === undefined) return null;
      const fileId = first.id;
      const downloadUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
      const downloadRes = await driveFetch(downloadUrl, {
        headers: authHeaders(token),
      });

      if (downloadRes.ok) {
        const config: unknown = await downloadRes.json();
        return config as Record<string, unknown> | null;
      }
    }
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
): Promise<boolean> {
  const url = buildConfigSearchUrl();

  try {
    const searchRes = await driveFetch(url, {
      headers: authHeaders(token),
    });

    let fileId: string | null = null;
    if (searchRes.ok) {
      const searchData: unknown = await searchRes.json();
      const files = parseFilesList(searchData);
      if (files.length > 0) {
        const first = files[0];
        if (first !== undefined) fileId = first.id;
      }
    }

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
 * conditional upsert). Failures log and return false; the caller keeps using
 * its in-memory config.
 * @param token Drive access token.
 * @param config Any JSON-serializable config object.
 * @returns true when Drive confirmed the write, false on any failure.
 */
export async function saveAppConfig(
  token: string,
  config: unknown,
): Promise<boolean> {
  return withSaveConfigLock(() => saveAppConfigInternal(token, config));
}
