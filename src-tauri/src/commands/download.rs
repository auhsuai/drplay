//! Streams a Drive file directly to disk instead of buffering the whole
//! file in the frontend renderer's memory before saving.
//!
//! The previous approach (`src/ui/components/MoreMenu/hooks/useDownload.ts`)
//! did `await response.blob()` in the browser, holding the entire file in
//! renderer memory before handing it to a synthetic `<a download>` click.
//! For a large lossless FLAC this could be a meaningful, unnecessary memory
//! spike. This command fetches with `reqwest` and writes each chunk to disk
//! as it arrives, so memory usage stays bounded regardless of file size.
use tokio::io::AsyncWriteExt;
use tokio_stream::StreamExt;

use crate::AppError;

#[tauri::command]
pub async fn download_file_to_disk(file_id: String, dest_path: String) -> Result<(), AppError> {
    let token = crate::GLOBAL_STREAM_TOKEN.lock().await.clone();
    if token.is_empty() {
        return Err(AppError::Auth("No valid access token".to_string()));
    }

    let client = reqwest::Client::new();
    let url = format!("https://www.googleapis.com/drive/v3/files/{file_id}?alt=media");
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| AppError::Other(format!("Request failed: {e}")))?;

    if !resp.status().is_success() {
        return Err(AppError::Other(format!("Drive returned status {}", resp.status())));
    }

    let mut file = tokio::fs::File::create(&dest_path)
        .await
        .map_err(|e| AppError::Io(format!("Failed to create file at {dest_path}: {e}")))?;

    let mut stream = resp.bytes_stream();
    let mut wrote_any = false;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| AppError::Other(format!("Stream read error: {e}")))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| AppError::Io(format!("Write error: {e}")))?;
        wrote_any = true;
    }
    file.flush()
        .await
        .map_err(|e| AppError::Io(format!("Flush error: {e}")))?;

    if !wrote_any {
        // Drive returned 2xx with an empty body -- treat as a failure rather
        // than silently leaving a 0-byte file the user thinks is their track.
        let _ = tokio::fs::remove_file(&dest_path).await;
        return Err(AppError::Io("Download completed with zero bytes".to_string()));
    }

    Ok(())
}
