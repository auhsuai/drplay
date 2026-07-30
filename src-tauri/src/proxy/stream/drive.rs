use reqwest::{Client, StatusCode};
use crate::proxy::constants::FALLBACK_CONTENT_TYPE;
use crate::proxy::drive_error::{classify_drive_error, DriveErr};

pub async fn fetch_range_from_drive(
    client: &Client,
    api_url: &str,
    token: &str,
    start: u64,
    end: u64,
) -> Result<Vec<u8>, DriveErr> {
    let range = format!("bytes={}-{}", start, end);
    let resp = client.get(api_url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Range", &range)
        .send()
        .await
        .map_err(|_| DriveErr::Upstream)?;

    let status = resp.status();
    if !status.is_success() && status != StatusCode::PARTIAL_CONTENT {
        let code = status.as_u16();
        let body = resp.text().await.unwrap_or_default();
        return Err(classify_drive_error(code, &body));
    }

    let expected_len = (end - start + 1) as usize;
    let bytes = resp.bytes().await.map_err(|_| DriveErr::Upstream)?;

    if bytes.len() != expected_len && end != u64::MAX {
        return Err(DriveErr::Upstream);
    }

    Ok(bytes.to_vec())
}

pub async fn get_total_size(
    client: &Client,
    api_url: &str,
    token: &str,
) -> Result<(u64, String), DriveErr> {
    let resp = client.get(api_url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Range", "bytes=0-0")
        .send()
        .await
        .map_err(|_| DriveErr::Upstream)?;
    let status = resp.status();
    if !status.is_success() && status != StatusCode::PARTIAL_CONTENT {
        let code = status.as_u16();
        let body = resp.text().await.unwrap_or_default();
        return Err(classify_drive_error(code, &body));
    }
    let ctype = resp.headers().get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or(FALLBACK_CONTENT_TYPE)
        .to_string();
    let total = resp.headers().get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.rsplit('/').next())
        .and_then(|s| s.trim().parse::<u64>().ok())
        .or_else(|| resp.headers().get(reqwest::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok()))
        .ok_or(DriveErr::Upstream)?;
    Ok((total, ctype))
}
