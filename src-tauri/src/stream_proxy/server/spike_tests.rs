//! Manual spike against the real Google Drive API (mirrors the Task 1
//! `mpv_real_pipeline_spike` pattern). Run with:
//! `cargo test real_drive_range_spike -- --ignored --nocapture`
//! Requires a signed-in refresh token in the OS credential vault; it uses
//! the stored credential only — no secrets are hard-coded or printed.

use super::*;
use crate::stream_proxy::DriveTokenSource;

#[tokio::test(flavor = "multi_thread")]
#[ignore = "spike against the real Google Drive API"]
async fn real_drive_range_spike() {
    let tokens: Arc<dyn TokenSource> = Arc::new(DriveTokenSource::default());
    let access = Arc::clone(&tokens)
        .refresh(false)
        .await
        .expect("access token must be mintable (sign in via the app first)");
    println!("access token minted (length {})", access.len());

    // Pick one real audio file through the Drive listing API.
    let client = reqwest::Client::new();
    let list = client
        .get("https://www.googleapis.com/drive/v3/files")
        .query(&[
            ("pageSize", "5"),
            ("q", "mimeType contains 'audio/'"),
            ("fields", "files(id,name)"),
            ("orderBy", "modifiedTime desc"),
        ])
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {access}"))
        .send()
        .await
        .expect("files.list request must succeed");
    assert_eq!(list.status(), 200, "files.list failed");
    let listing: serde_json::Value = list.json().await.expect("files.list must return JSON");
    let files = listing["files"].as_array().cloned().unwrap_or_default();
    assert!(!files.is_empty(), "no audio files found in this Drive");
    let file_id = files[0]["id"].as_str().expect("file id must be a string").to_string();
    let file_name = files[0]["name"].as_str().unwrap_or("?").to_string();
    println!("spiking with file: {file_name} ({file_id})");

    // Raw upstream probe with redirects disabled: does Drive answer 200
    // directly or 302 to googleusercontent.com (the manual-follow case)?
    let no_follow = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("probe client must build");
    let direct = no_follow
        .get(format!("https://www.googleapis.com/drive/v3/files/{file_id}"))
        .query(&[("alt", "media")])
        .header(reqwest::header::RANGE, "bytes=0-1023")
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {access}"))
        .send()
        .await
        .expect("direct upstream probe must succeed");
    println!("direct upstream status (Policy::none): {}", direct.status());

    // Start the production proxy (real base URL, real token source).
    let sink: ErrorSink = Arc::new(|file_id: String, status: u16| {
        println!("[spike] stream-proxy-error {file_id} {status}");
    });
    let port = spawn_proxy(
        sink,
        "https://www.googleapis.com".to_string(),
        tokens,
        Duration::from_secs(15),
        crate::stream_proxy::UPSTREAM_BODY_IDLE_TIMEOUT,
    )
    .expect("proxy must start");

    // Range request through the proxy, exactly like mpv will issue.
    let response = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{port}/stream/{file_id}"))
        .header(reqwest::header::RANGE, "bytes=0-1023")
        .send()
        .await
        .expect("proxy request must succeed");
    let status = response.status().as_u16();
    let content_range = response
        .headers()
        .get("content-range")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let body = response.bytes().await.expect("body must stream");
    println!("proxy status: {status}");
    println!("proxy content-range: {:?}", content_range);
    println!("proxy body bytes: {}", body.len());

    assert_eq!(status, 206, "expected 206 Partial Content through the proxy");
    assert_eq!(body.len(), 1024, "expected exactly 1024 body bytes");
    assert!(
        content_range
            .as_deref()
            .map(|value| value.starts_with("bytes 0-1023/"))
            .unwrap_or(false),
        "Content-Range must cover bytes 0-1023"
    );
    println!("SPIKE OK: 206 + 1024 bytes + Content-Range through the localhost proxy");
}
