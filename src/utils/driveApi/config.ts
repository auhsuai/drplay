import { driveFetch, classifyDriveError } from './core';

const DRIVE_MODULE = "driveApi";

// App Configuration in appDataFolder
export async function getAppConfig(token: string): Promise<any> {
  const q = "name = 'drplay_config.json' and 'appDataFolder' in parents";
  const url = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${encodeURIComponent(q)}&fields=files(id)`;
  
  try {
    const searchRes = await driveFetch(url, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (!searchRes.ok) return null;
    const searchData = await searchRes.json();
    
    if (searchData.files && searchData.files.length > 0) {
      const fileId = searchData.files[0].id;
      const downloadUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
      const downloadRes = await driveFetch(downloadUrl, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      
      if (downloadRes.ok) {
        return await downloadRes.json();
      }
    }
  } catch (e) {
    console.error(`[${DRIVE_MODULE}] get-config-failed`, classifyDriveError(e));
  }
  return null;
}

// Serialize config writes with a promise-chain mutex. Two concurrent saves
// would otherwise both search (find nothing), both POST, and create duplicate
// drplay_config.json files in appDataFolder (Drive has no conditional upsert).
// Chaining forces the 2nd save to observe the file the 1st created → PATCH.
let saveConfigChain: Promise<unknown> = Promise.resolve();

async function saveAppConfigInternal(token: string, config: any): Promise<boolean> {
  const q = "name = 'drplay_config.json' and 'appDataFolder' in parents";
  const url = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${encodeURIComponent(q)}&fields=files(id)`;

  try {
    const searchRes = await driveFetch(url, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    let fileId = null;
    if (searchRes.ok) {
      const searchData = await searchRes.json();
      if (searchData.files && searchData.files.length > 0) {
        fileId = searchData.files[0].id;
      }
    }

    const boundary = '-------314159265358979323846';
    const delimiter = `\r\n--${boundary}\r\n`;
    const close_delim = `\r\n--${boundary}--`;

    const metadata = {
      name: 'drplay_config.json',
      mimeType: 'application/json',
      ...(fileId ? {} : { parents: ['appDataFolder'] })
    };

    const multipartRequestBody =
      delimiter +
      'Content-Type: application/json\r\n\r\n' +
      JSON.stringify(metadata) +
      delimiter +
      'Content-Type: application/json\r\n\r\n' +
      JSON.stringify(config) +
      close_delim;

    const uploadUrl = fileId
      ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`
      : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;

    const uploadRes = await driveFetch(uploadUrl, {
      method: fileId ? 'PATCH' : 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`
      },
      body: multipartRequestBody
    });

    if (!uploadRes.ok) {
      console.error(`[${DRIVE_MODULE}] save-config-upload-failed`, { status: uploadRes.status });
      return false;
    }
    return true;
  } catch (e) {
    console.error(`[${DRIVE_MODULE}] save-config-failed`, classifyDriveError(e));
    return false;
  }
}

export function saveAppConfig(token: string, config: any): Promise<boolean> {
  const run = saveConfigChain.then(() => saveAppConfigInternal(token, config));
  // Keep the chain alive even if a save fails, and swallow here to avoid an
  // unhandled rejection; the real result/rejection is returned to the caller.
  saveConfigChain = run.catch(() => {});
  return run;
}
