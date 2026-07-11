use std::time::Instant;
use tokio::net::TcpListener;
use axum::{routing::get, Router, http::{HeaderMap, StatusCode, header}, response::IntoResponse};
use std::sync::Arc;

const FILE_SIZE: usize = 20 * 1024 * 1024; // 20 MB audio file
const ID3_TAG_SIZE: usize = 3 * 1024 * 1024; // 3 MB cover art

fn create_mock_mp3() -> Vec<u8> {
    let mut data = vec![0u8; FILE_SIZE];
    
    // Write ID3v2 header
    data[0..3].copy_from_slice(b"ID3");
    data[3] = 4; // Version
    data[4] = 0; // Revision
    data[5] = 0; // Flags
    
    // Size is encoded in 4 bytes, 7 bits each.
    // 3 MB = 3145728 bytes = 0x300000.
    // In sync-safe integer:
    let size = ID3_TAG_SIZE as u32;
    data[6] = ((size >> 21) & 0x7F) as u8;
    data[7] = ((size >> 14) & 0x7F) as u8;
    data[8] = ((size >> 7) & 0x7F) as u8;
    data[9] = (size & 0x7F) as u8;
    
    data
}

async fn serve_file(headers: HeaderMap, state: Arc<Vec<u8>>) -> impl IntoResponse {
    let mut start = 0;
    let mut end = state.len() - 1;
    
    if let Some(range) = headers.get(header::RANGE) {
        let range_str = range.to_str().unwrap();
        if range_str.starts_with("bytes=") {
            let parts: Vec<&str> = range_str[6..].split('-').collect();
            if let Ok(s) = parts[0].parse::<usize>() {
                start = s;
            }
            if parts.len() > 1 && !parts[1].is_empty() {
                if let Ok(e) = parts[1].parse::<usize>() {
                    end = e;
                }
            }
        }
    }
    
    end = std::cmp::min(end, state.len() - 1);
    let len = end - start + 1;
    
    let res = axum::response::Response::builder()
        .status(if headers.contains_key(header::RANGE) { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK })
        .header(header::CONTENT_LENGTH, len.to_string())
        .header(header::CONTENT_RANGE, format!("bytes {}-{}/{}", start, end, state.len()));
        
    res.body(axum::body::Body::from(state[start..=end].to_vec())).unwrap()
}

#[tokio::main]
async fn main() {
    let data = Arc::new(create_mock_mp3());
    
    let app = Router::new()
        .route("/file", get({
            let data = data.clone();
            move |headers| serve_file(headers, data.clone())
        }));
        
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    
    let url = format!("http://127.0.0.1:{}/file", port);
    let client = reqwest::Client::new();
    
    // Method A: Download whole file (Frontend behavior when scanMode !== 'fast')
    let start = Instant::now();
    let resp = client.get(&url).send().await.unwrap();
    let bytes = resp.bytes().await.unwrap();
    let time_a = start.elapsed();
    println!("Method A (Whole file, {} MB): {:?}", bytes.len() / 1024 / 1024, time_a);
    
    // Method B: Fixed 128KB Range (extract_metadata_safe behavior)
    let start = Instant::now();
    let resp = client.get(&url).header("Range", "bytes=0-131072").send().await.unwrap();
    let bytes = resp.bytes().await.unwrap();
    let time_b = start.elapsed();
    println!("Method B (Fixed 128KB, {} KB): {:?}", bytes.len() / 1024, time_b);
    
    // Check if 128KB has full ID3 tag
    let mut has_full_tag = false;
    if bytes.len() >= 10 && bytes[0..3] == b"ID3"[..] {
        let size = ((bytes[6] as usize) << 21) | ((bytes[7] as usize) << 14) | ((bytes[8] as usize) << 7) | (bytes[9] as usize);
        if bytes.len() >= size + 10 {
            has_full_tag = true;
        }
    }
    println!("Method B fetched full ID3 tag? {}", has_full_tag);
    
    // Method C: Exact ID3 Range (Best practice)
    let start = Instant::now();
    // 1. Fetch 10 bytes header
    let resp = client.get(&url).header("Range", "bytes=0-9").send().await.unwrap();
    let header_bytes = resp.bytes().await.unwrap();
    let mut time_c = start.elapsed();
    
    if header_bytes.len() == 10 && header_bytes[0..3] == b"ID3"[..] {
        let size = ((header_bytes[6] as usize) << 21) | ((header_bytes[7] as usize) << 14) | ((header_bytes[8] as usize) << 7) | (header_bytes[9] as usize);
        
        let start2 = Instant::now();
        // Fetch the rest of the tag
        let resp2 = client.get(&url).header("Range", format!("bytes=10-{}", 10 + size - 1)).send().await.unwrap();
        let body_bytes = resp2.bytes().await.unwrap();
        time_c += start2.elapsed();
        println!("Method C (Exact ID3 Range, {} KB): {:?}", (10 + body_bytes.len()) / 1024, time_c);
    }
}
