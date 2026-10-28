/** One `stream-proxy-error` payload (R05) as the engine remembers it. Status
 *  memory only — never a display channel: mpv's end-file is the single place
 *  an error surfaces. */
export interface ProxyErrorRecord {
  fileId: string;
  status: number;
}
